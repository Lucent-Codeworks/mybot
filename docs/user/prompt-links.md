# Prompt links

A prompt link opens T3 Code with a prompt ready to send. Use one to share a prompt on social
media or in a chat, issue, or document.

A link never runs anything. It opens a draft. You read the prompt, then press Send. A link cannot
change your permission mode. Your own defaults apply.

## Make a link

Open the command palette and choose **Copy prompt link**. It copies the draft in the composer.
**Copy prompt link with model** also adds the model you picked. Sent messages have a **Copy prompt link** button too.

You can also write a link by hand:

```
https://app.t3.codes/new?prompt=Rate%20my%20swearing
https://app.t3.codes/new?prompt=Fix%20the%20build&provider=codex&model=gpt-5.5
```

| Parameter  | Meaning                                         |
| ---------- | ----------------------------------------------- |
| `prompt`   | The prompt. Required. At most 8,000 characters. |
| `provider` | A provider such as `codex` or `claude`.         |
| `model`    | A model of that provider, by its id or name.    |

Encode the prompt for a URL. In JavaScript, use `encodeURIComponent`.

## Open a link

On app.t3.codes, the link first asks where to open it: the desktop or mobile app, this browser
when it is connected to a machine, or the download page. Select **Remember my choice** to skip
this step next time.

The draft opens without a project, on the machine you used last. `provider` and `model` are used
when you have that provider set up. Otherwise your default model is used, and T3 Code tells you.

A thread link with a prompt, such as `https://app.t3.codes/<environment>/<thread>?prompt=…`,
puts the prompt in that thread's composer. If you already typed a draft there, T3 Code asks
before it replaces it.

T3 Code removes characters you cannot see, such as zero-width and hidden tag characters, because
they can hide instructions for the agent. When a prompt had them, T3 Code warns you that it may be
malicious.
