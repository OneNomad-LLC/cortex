# Fly base-image build target

The actual `fly.toml` and `Dockerfile` live at the **repo root**, not here, because Fly's build context defaults to the directory containing `fly.toml` and the Dockerfile needs the whole monorepo as its build context.

This directory exists as a documentation pointer — see `deploy/README.md` for the full story.

## TL;DR

```sh
# From the repo root:
fly deploy -a cortex-base --build-only --push
```

That's it. The `cortex-base` Fly app is a build target only — nothing actually runs in it. pyre-web's tenant provisioner pulls `registry.fly.io/cortex-base:latest` and creates per-tenant Fly Machines from it.

## Why isn't fly.toml here?

We considered moving `fly.toml` and `Dockerfile` into this directory for cleanliness, but Fly's build context is rooted at `fly.toml`'s directory. Moving them would require either:

- Updating the Dockerfile's `COPY` paths to walk back up the tree (`COPY ../../packages ./packages`), which Fly's build context doesn't allow
- Passing `--build-context <path>` on every `fly deploy` invocation, which is easy to forget and breaks CI

Keeping them at the repo root is the lower-risk, lower-friction shape. The header comments in `fly.toml` and `Dockerfile` make it clear they're build targets, not runtime apps.
