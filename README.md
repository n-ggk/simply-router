# simply-router

An OpenCode plugin that rotates multiple API keys per provider. When the key in
use hits its rate limit, simply-router puts it in a cooldown and retries the
request immediately on a fresh key — so you keep working instead of waiting out
the provider's per-account back-off.

Each key belongs to a separate account (the weekly allowance is shared per
account, not per key), and the plugin keeps its own round-robin state for every
provider it finds a key file for.

## What it does

- Loads one key file per provider from a keys directory: `<provider>.txt`, one
  key per line.
- Injects `Authorization: Bearer <key>` on every request, using the next
  available key in round-robin order for that provider.
- Benches the exact key on `401`/`403` or a `429` explicitly identified as a
  key-level limit.
- Does not bench or retry another key for recognized account/model allowance
  errors such as `free_tier_limit_reached`.
- Rotates immediately for key-level failures, up to the retry cap; unclassified
  `429`s keep the provider's original retry policy.
- Stops injecting a key and refuses to retry when every key for a provider is
  benched.
- Never logs or returns a key — only the key index.

## Install

### Project-local

The recommended setup. Run OpenCode from the repository and it discovers
`.opencode/plugins/shim.ts` automatically.

```bash
git clone https://github.com/n-ggk/simply-router.git
cd simply-router
bun install
```

Then [configure the provider](#configure) and start OpenCode from this
directory:

```bash
opencode
```

### Global

Install once and use it from every project.

```bash
git clone https://github.com/n-ggk/simply-router.git ~/.config/opencode/simply-router
cd ~/.config/opencode/simply-router && bun install
```

Create the entry file OpenCode discovers under your config directory:

```bash
mkdir -p ~/.config/opencode/plugins
```

```ts title="~/.config/opencode/plugins/simply-router.ts"
export { SimplyRouter as default } from "../simply-router/src/main"
```

Then [configure the provider](#configure) in `~/.config/opencode/opencode.json`.
To load it from a location other than the default, point OpenCode at the plugin
directory instead of relying on discovery:

```jsonc title="~/.config/opencode/opencode.json"
{
  "plugins": ["~/.config/opencode/simply-router"]
}
```

A local plugin path must be a directory; a path to a single file is ignored.

## Configure

### 1. Add your keys

Create the default keys directory and one file per provider. The file name
(without `.txt`) must match the provider id in `opencode.json` — for the
provider `<provider>`, the file is `<provider>.txt`.

```bash
mkdir -p ~/provider/keys
printf '%s\n' "key-account-a" "key-account-b" > ~/provider/keys/<provider>.txt
```

Rules:

- One key per line; every non-empty line is a key, so comments are not
  supported.
- Providers without a matching `.txt` file are ignored by the plugin.
- Keys must belong to **different accounts**. Keys from the same account share
  the weekly limit and will all fail together.

### 2. Point your provider at the plugin

In `opencode.json` (or `opencode.jsonc`), reference the environment variable the
plugin populates and keep the keys out of the file:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "<provider>": {
      "name": "Provider Example",
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "https://exampleprovider.ai/v1",
        "apiKey": "{env:MY_API_KEY-<provider>}"
      },
      "models": {}
    }
  }
}
```

The plugin sets `MY_API_KEY-<provider>` at setup to the first key of that
provider's file (when the variable is not already set), so the reference
resolves. Rotation happens per request after that.

### 3. Options and environment variables

| Setting | Plugin option | Environment variable | Default |
| --- | --- | --- | --- |
| Keys directory | `keysDir` | `SIMPLY_ROUTER_KEYS_DIR` | `~/<provider>/keys` |
| Retry cap per request | `maxRetries` | `SIMPLY_ROUTER_MAX_RETRIES` | Number of keys for the provider |
| Request tracing | — | `SIMPLY_ROUTER_TRACE=1` | Off |
| Trace file | — | `SIMPLY_ROUTER_TRACE_FILE` | `<tmpdir>/simply-router-trace.log` |

The keys directory precedence is: plugin option `keysDir` > value stored by
`/simplyrouter -keydirectory-set` > `SIMPLY_ROUTER_KEYS_DIR` > the default.

Environment variables are the simplest way to set either value:

```bash
export SIMPLY_ROUTER_KEYS_DIR="$HOME/work/keys"
export SIMPLY_ROUTER_MAX_RETRIES=4
opencode
```

When you load the plugin through `opencode.json`, pass the same values as
`options` in the plugin entry. The entry shape is the documented object form:

```jsonc title="opencode.json"
{
  "plugins": [
    {
      "package": "simply-router",
      "options": { "keysDir": "~/work/keys", "maxRetries": 4 }
    }
  ]
}
```

`maxRetries` caps how many attempt numbers a single request may reach. The
default is the provider's key count, which is enough for the request to try
every key once; lowering it can give up while keys are still available.

## Usage

Use OpenCode normally. Key selection, benching, and retry are automatic.

### Commands

| Command | Effect |
| --- | --- |
| `/simplyrouter reset` | Clears every cooldown and restarts rotation at the first key. |
| `/simplyrouter -keydirectory-set <path>` | Validates and switches the keys directory, reloads every provider, and stores the choice. |
| `/simplyrouter -keydirectory-set` | Prints the current keys directory. |

An invalid path changes nothing. The same reset is available to the model as the
`simplyrouter_reset` tool.

### What happens on a failing key

1. `http.request` selects the next available key and sets `Authorization`.
2. `http.response` inspects 429 error details and benches the key only for a
   key-scoped failure; account/model allowance errors do not affect key cooldowns.
3. `retry` rotates immediately for key-scoped failures when another key is
   available. It vetoes retries for recognized account/model allowance errors;
   unclassified 429s retain the provider's retry decision and delay.

Typical log lines:

```text
simply-router: rotating 1 provider(s), 3 key(s) from /home/me/<provider>/keys.
simply-router: <provider> selected key #1.
simply-router: <provider> key #1 is cooling down for seven days (HTTP 429).
simply-router: retrying <provider> immediately on a fresh key.
simply-router: every <provider> key is cooling down; use /simplyrouter reset.
```

For an account/model allowance response, the key is not cooled down and the
request is not retried on another key:

```text
simply-router: <provider> account/model allowance is exhausted; not retrying.
```

### Tracing

Set `SIMPLY_ROUTER_TRACE=1` to append one line per request and per retry
decision. This is the way to confirm how a `429` was classified:

```bash
SIMPLY_ROUTER_TRACE=1 opencode
```

Expected trace for a key-level 429:

```text
... http.request provider=<provider> kind=primary key=#1
... http.response provider=<provider> status=429 scope=key cooled-#1
... retry provider=<provider> attempt=2 status=429 scope=key proposed-delay=900000
... retry attempt=2 -> delay=0 (fresh key, max=3)
... http.request provider=<provider> kind=primary key=#2
```

For an account/model allowance 429, the trace reports `scope=account`,
`skipped-cooldown`, and a vetoed retry. Unknown 429s report `scope=unknown` and
leave the provider's retry policy unchanged.

## Notes and limitations

- **Cooldowns live in memory.** Restarting OpenCode clears every cooldown and
  resets rotation. Only the keys directory is persisted.
- **Seven days is fixed.** The cooldown duration is a constant, not an option.
- **Only the key that failed is benched.** A key is never benched because a
  different provider or request failed.
- **Rotation is per provider id.** Any provider with a `<provider>.txt` file is
  rotated without code changes.

## Development

```bash
bun install    # dependencies
bun test       # unit tests for rotation, cooldown, reset, and key loading
bun run check  # tsc --noEmit
```

`bun test` covers the pure helpers in `src/main.ts`; the hooks themselves are
verified manually with `SIMPLY_ROUTER_TRACE=1` (see [Tracing](#tracing)).

## Repository layout

```text
simply-router/
├── src/main.ts              # Plugin: key loading, rotation state, hooks, commands
├── .opencode/plugins/shim.ts  # Re-exports the plugin for project-local discovery
├── test/unit.test.ts        # Bun unit tests
├── package.json             # Scripts and dev dependencies
└── tsconfig.json            # TypeScript configuration (noEmit)
```

## License

[MIT](./LICENSE) © n-ggk
