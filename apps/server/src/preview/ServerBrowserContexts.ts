// @effect-diagnostics nodeBuiltinImport:off - Owns Playwright resources outside the Effect runtime.
import { INCOGNITO_BROWSER_PROFILE_ID } from "@mybot/contracts";
import { constVoid } from "effect/Function";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { Browser, BrowserContext, CDPSession } from "playwright-core";

import { sandboxDisabled } from "./PreviewBrowserHost.ts";

// Playwright needs its files on disk. createRequire also resolves it from a Node SEA executable.
const requirePlaywright = NodeModule.createRequire(import.meta.url);
const loadPlaywright = () =>
  requirePlaywright("playwright-core") as typeof import("playwright-core");

interface Options {
  readonly profilesDir: string;
  /** The shared headless browser's executable, installing it on first use. */
  readonly executable: () => Promise<string>;
  /**
   * The user's own Google Chrome, if installed. Preferred over the headless
   * shell, which captcha services recognize as a bot.
   */
  readonly installedChrome?: () => Promise<string | undefined>;
  /** Replaces a failed launch's error with the host setup it is missing, if any. */
  readonly diagnose?: (executable: string, cause: unknown) => Promise<unknown>;
  readonly env?: NodeJS.ProcessEnv;
  readonly onContextClose?: (context: BrowserContext) => void;
}

const UA_PLATFORMS: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "macOS",
  linux: "Linux",
  win32: "Windows",
};

const GREASE_CHARS = [" ", "(", ":", "-", ".", "/", ")", ";", "=", "?", "_"];
const GREASE_VERSIONS = ["8", "99", "24"];
const GREASE_ORDERS = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
] as const;

/**
 * Chrome's brand list for a major version, as Chromium's
 * `GenerateBrandVersionList` derives it: the GREASE brand's name, version, and
 * position all follow from the major version. Sites compare it with the user
 * agent, so it must match whichever Chrome build runs.
 */
export const chromeBrands = (major: number) => {
  const grease = {
    brand: `Not${GREASE_CHARS[major % 11]}A${GREASE_CHARS[(major + 1) % 11]}Brand`,
    version: GREASE_VERSIONS[major % 3]!,
  };
  const ordered = [
    grease,
    { brand: "Chromium", version: String(major) },
    { brand: "Google Chrome", version: String(major) },
  ];
  const list: Array<{ brand: string; version: string }> = [];
  GREASE_ORDERS[major % 6]!.forEach((slot, index) => {
    list[slot] = ordered[index]!;
  });
  return list;
};

const CHROME_PATHS: Partial<Record<NodeJS.Platform, (env: NodeJS.ProcessEnv) => string[]>> = {
  darwin: () => ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
  linux: () => ["/opt/google/chrome/chrome"],
  win32: (env) =>
    [env["LOCALAPPDATA"], env["PROGRAMFILES"], env["PROGRAMFILES(X86)"]].flatMap((root) =>
      root ? [NodePath.win32.join(root, "Google", "Chrome", "Application", "chrome.exe")] : [],
    ),
};

/** Google Chrome where its installer puts it, as Playwright's `chrome` channel looks for it. */
export const findInstalledChrome = async (
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> => {
  for (const candidate of CHROME_PATHS[platform]?.(env) ?? []) {
    if (
      await NodeFSP.access(candidate, NodeFSP.constants.X_OK).then(
        () => true,
        () => false,
      )
    )
      return candidate;
  }
  return undefined;
};

/**
 * A headless browser's identity as the Chrome it is built from: its user agent
 * without `HeadlessChrome`, and client hints whose brands agree with it. Sites
 * block a user agent that disagrees with `Sec-CH-UA`, so both change together.
 */
const chromeIdentity = (
  headlessUserAgent: string,
  product: string,
  host: { readonly platform: NodeJS.Platform; readonly arch: string; readonly release: string },
) => {
  const version = /HeadlessChrome\/((\d+)[\d.]*)/.exec(headlessUserAgent);
  // Newer Chrome reduces even its headless user agent; the product keeps the build.
  const fullVersion = /\/(\d[\d.]*)/.exec(product)?.[1] ?? version?.[1];
  const major = version?.[2];
  if (!version || !fullVersion || !major) return null;
  const brands = (names: (version: string) => string) =>
    chromeBrands(Number(major)).map(({ brand, version }) => ({ brand, version: names(version) }));
  return {
    // Chrome reduces its user agent to the major version.
    userAgent: headlessUserAgent.replace(version[0], `Chrome/${major}.0.0.0`),
    userAgentMetadata: {
      brands: brands((value) => value),
      fullVersionList: brands((value) => (value === major ? fullVersion : `${value}.0.0.0`)),
      platform: UA_PLATFORMS[host.platform] ?? "Unknown",
      platformVersion: host.platform === "linux" ? host.release : "",
      architecture: host.arch.startsWith("arm") ? "arm" : "x86",
      bitness: host.arch.endsWith("64") ? "64" : "32",
      model: "",
      mobile: false,
      wow64: false,
    },
  };
};

/**
 * Presents a headless page as plain Chrome. Applies to the page, its frames,
 * and its workers; a popup gets its own call once it becomes a tab.
 */
export const presentAsChrome = async (
  cdp: CDPSession,
  host: { readonly platform: NodeJS.Platform; readonly arch: string },
) => {
  const { userAgent, product } = await cdp.send("Browser.getVersion");
  const identity = chromeIdentity(userAgent, product, { ...host, release: NodeOS.release() });
  if (identity) await cdp.send("Emulation.setUserAgentOverride", identity);
};

const launchOptions = (
  executablePath: string,
  installedChrome: boolean,
  env: NodeJS.ProcessEnv,
) => ({
  executablePath,
  env,
  // People drive these tabs, so they must not announce automation (navigator.webdriver).
  args: [
    // Installed Chrome keeps its GPU: a software WebGL renderer marks a bot.
    ...(installedChrome ? [] : ["--disable-gpu"]),
    "--force-device-scale-factor=2",
    "--disable-blink-features=AutomationControlled",
  ],
  ignoreDefaultArgs: ["--enable-automation"],
  headless: true,
  // Only an explicit operator opt-out disables sandboxing. Launch errors never do.
  chromiumSandbox: !sandboxDisabled(env),
});

/** Persistent human profiles keep their storage; isolated agents share a browser, never a context. */
export class ServerBrowserContexts {
  private readonly options: Options;
  private readonly contexts = new Map<string, Promise<BrowserContext>>();
  /** Profile clears in progress; a context for that profile opens after its storage is gone. */
  private readonly clearing = new Map<string, Promise<void>>();
  private browser: Promise<Browser> | undefined;
  private closing: Promise<void> | undefined;

  constructor(options: Options) {
    this.options = options;
  }

  /** Launches the user's Chrome if it is installed and starts, else the headless shell. */
  private async launch<A>(start: (options: ReturnType<typeof launchOptions>) => Promise<A>) {
    const env = this.options.env ?? process.env;
    const chrome = await this.options.installedChrome?.();
    if (chrome !== undefined) {
      try {
        return await start(launchOptions(chrome, true, env));
      } catch {
        // The headless shell below still works, and its failure is the one to diagnose.
      }
    }
    const options = launchOptions(await this.options.executable(), false, env);
    try {
      return await start(options);
    } catch (cause) {
      throw (await this.options.diagnose?.(options.executablePath, cause)) ?? cause;
    }
  }

  private sharedBrowser() {
    if (!this.browser) {
      const launched = (async () => {
        const { chromium } = loadPlaywright();
        const browser = await this.launch((options) => chromium.launch(options));
        browser.on("disconnected", () => {
          if (this.browser === launched) this.browser = undefined;
        });
        return browser;
      })();
      this.browser = launched;
      void launched.catch(() => {
        if (this.browser === launched) this.browser = undefined;
      });
    }
    return this.browser;
  }

  contextFor(profileId: string, isolationKey?: string): Promise<BrowserContext> {
    if (this.closing) return Promise.reject(new Error("The preview browser is closed."));
    const key = JSON.stringify([profileId, isolationKey ?? null]);
    const cached = this.contexts.get(key);
    if (cached) return cached;
    const cleared = this.clearing.get(key)?.catch(constVoid) ?? Promise.resolve();
    const pending = cleared
      .then(() => this.createContext(profileId, isolationKey))
      .then(async (context) => {
        context.on("close", () => {
          if (this.contexts.get(key) === pending) this.contexts.delete(key);
          this.options.onContextClose?.(context);
        });
        for (const page of context.pages()) await page.close().catch(constVoid);
        if (this.closing) {
          await context.close().catch(constVoid);
          throw new Error("The preview browser is closed.");
        }
        return context;
      });
    this.contexts.set(key, pending);
    void pending.catch(() => {
      if (this.contexts.get(key) === pending) this.contexts.delete(key);
    });
    return pending;
  }

  private async createContext(profileId: string, isolationKey?: string) {
    const contextOptions = { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 };
    if (isolationKey !== undefined || profileId === INCOGNITO_BROWSER_PROFILE_ID) {
      const browser = await this.sharedBrowser();
      return browser.newContext(contextOptions);
    }
    const directory = this.profileDirectory(profileId);
    const { chromium } = loadPlaywright();
    await NodeFSP.mkdir(directory, { recursive: true });
    return this.launch((options) =>
      chromium.launchPersistentContext(directory, { ...options, ...contextOptions }),
    );
  }

  private profileDirectory(profileId: string) {
    const encoded = encodeURIComponent(profileId);
    return NodePath.join(
      this.options.profilesDir,
      profileId === "." || profileId === ".." ? encoded.replaceAll(".", "%2E") : encoded,
    );
  }

  /** A throwaway page in the shared browser, for work that must not touch a tab's own storage. */
  async scratchPage() {
    if (this.closing) throw new Error("The preview browser is closed.");
    const context = await (await this.sharedBrowser()).newContext();
    const page = await context.newPage();
    page.once("close", () => void context.close().catch(constVoid));
    return page;
  }

  /**
   * Drives a page the desktop app renders, through the CDP endpoint its relay
   * serves. The page keeps the desktop's storage, size, and window.
   */
  async connectDesktopPage(endpoint: string) {
    const { chromium } = loadPlaywright();
    const browser = await chromium.connectOverCDP(endpoint, { timeout: 15_000 });
    const page = browser.contexts().flatMap((context) => context.pages())[0];
    if (!page) {
      await browser.close().catch(constVoid);
      throw new Error("The desktop tab has no page.");
    }
    return { browser, page };
  }

  /** Closes a human profile's persistent context, ending its tabs, then deletes its storage. */
  async clearProfile(profileId: string) {
    if (profileId === INCOGNITO_BROWSER_PROFILE_ID) return;
    const key = JSON.stringify([profileId, null]);
    const clearing = (async () => {
      const pending = this.contexts.get(key);
      if (pending) {
        this.contexts.delete(key);
        const context = await pending.catch(() => undefined);
        await context?.close();
      }
      await NodeFSP.rm(this.profileDirectory(profileId), { recursive: true, force: true });
    })();
    this.clearing.set(key, clearing);
    try {
      await clearing;
    } finally {
      if (this.clearing.get(key) === clearing) this.clearing.delete(key);
    }
  }

  close() {
    this.closing ??= this.dispose();
    return this.closing;
  }

  private async dispose() {
    await Promise.allSettled(
      [...this.contexts.values()].map(async (pending) => (await pending).close()),
    );
    const browser = await this.browser?.catch(() => undefined);
    await browser?.close().catch(constVoid);
    this.contexts.clear();
  }
}
