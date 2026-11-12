# For integrators

This guide is written for **people using the viewer**. Developer documentation (ports, contracts, host
setup) lives in the repository: start with the
[README](https://github.com/TheJacksonLaboratory/sci-image-visualizer#readme) and the
[host integration guide](https://github.com/TheJacksonLaboratory/sci-image-visualizer/blob/main/docs/guides/host-integration.md).

This page covers how the guide reaches users of an application that embeds SIV, such as JAX Image Tools
(JIT).

## Where the Help buttons point

The toolbar's <i class="pi pi-question-circle"></i> **Help** button and the Region Editor's
<i class="pi pi-question"></i> **Help** button open this guide in a new browser tab:

| Button                 | Opens                       |
| ---------------------- | --------------------------- |
| Toolbar Help           | `reference/toolbar/`        |
| Region Editor Help     | `reference/region-editor/`  |

By default they open the published guide at
<https://thejacksonlaboratory.github.io/sci-image-visualizer/docs/> (exported as `SIV_DOCS_URL`). To open
your own copy instead (an offline deployment, or a host site that bundles the guide), set `docsUrl` in
`VIZ_CONFIG`:

```ts
{ provide: VIZ_CONFIG, useValue: { slideCropServer: '…', docsUrl: '/docs/visualization/' } }
```

The page paths above are appended to `docsUrl`, so the guide must keep its own folder structure under that
prefix. To hide the toolbar's Help button, pass `toolbarTools` with `help: false`.

!!! note "Contributed tools"
    Tools registered through `TOOLBAR_TOOLS` / `TOOLBAR_DIALOG_TOOLS` (for example JIT's YOLO and retinal
    layer tools) used to add an entry to the in-app help dialog through their `help` field. That dialog has
    been replaced by this guide, so `help` is deprecated and no longer shown. Document those tools in the
    host's own guide.

## Bundling the guide into a host's mkdocs site

The guide's sources ship inside the npm package:

```text
node_modules/@jax-data-science/sci-image-visualizer/docs/user-guide/
├── mkdocs.yml        # site config: nav and extra_css
└── docs/             # Markdown pages, screenshots and icons
```

Because they are versioned with the package, the guide a host bundles always matches the SIV version it
runs. A host merges it by reading `nav` and `extra_css` from that `mkdocs.yml` and mounting the pages of
`docs/` under a folder of its own site. JAX Image Tools mounts them under `visualization/` as the
"Image viewer (SIV)" section (see
[jit-ui#176](https://github.com/TheJacksonLaboratory/jit-ui/issues/176)), and can build against a local
SIV checkout instead of the installed package by pointing `SIV_DOCS_DIR` at the folder that holds this
`mkdocs.yml`.

Set `docsUrl` to the mount point, e.g. `'/docs/visualization/'`, so the Help buttons open the host's copy.

What the guide promises a host:

- Pages link to each other only with relative links inside `docs/`; nothing points outside it.
- Every asset sits inside `docs/assets/`. The host must load the two stylesheets listed in `extra_css`
  (`assets/primeicons/primeicons.css` for the toolbar icons, `assets/siv-docs.css`).
- The theme is [Material for MkDocs](https://squidfunk.github.io/mkdocs-material/), with these Markdown
  extensions: `admonition`, `attr_list`, `md_in_html`, `tables`, `def_list`, `footnotes`, `toc`,
  `pymdownx.details`, `pymdownx.keys`, `pymdownx.superfences`, `pymdownx.tabbed`, `pymdownx.tasklist` and
  `pymdownx.emoji` (Material's twemoji index, for the `:material-…:` icons). No plugins.

## Building and previewing the guide

```bash
pip install -r docs/user-guide/requirements.txt
npm run docs:serve     # live preview on http://127.0.0.1:8000
npm run docs:build     # static site in docs/user-guide/site (strict: warnings fail the build)
```

Screenshots live in `docs/user-guide/docs/assets/screenshots/`. Every one is listed, with the steps to
reproduce it, in `docs/user-guide/screenshots.json`. Run `npm run docs:placeholders` to generate a labelled
placeholder for each one still missing, and `npm run docs:placeholders -- --check` to list the
placeholders that still need replacing.
