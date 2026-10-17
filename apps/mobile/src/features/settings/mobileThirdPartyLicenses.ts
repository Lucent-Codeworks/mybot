import {
  decodeThirdPartyLicenseManifest,
  type ThirdPartyLicenseManifest,
} from "@mybot/shared/thirdPartyLicenses";

let cachedManifest: ThirdPartyLicenseManifest | undefined;

export function getMobileThirdPartyLicenses(): ThirdPartyLicenseManifest {
  if (cachedManifest) return cachedManifest;
  const generatedManifest: unknown = require("@mybot/mobile-third-party-licenses");
  cachedManifest = decodeThirdPartyLicenseManifest(generatedManifest);
  return cachedManifest;
}
