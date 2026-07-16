# Tab Out

**Keep tabs on your tabs.**

Tab Out is a Chrome extension that replaces your new tab page with a dashboard of everything you have open. Tabs can be grouped by domain or website type. Close tabs with a satisfying swoosh + confetti.

No server and no account. Website types use local rules first; optional DeepSeek classification is available for unknown domains.

---

## Install with a coding agent

Send your coding agent (Claude Code, Codex, etc.) this repo and say **"install this"**:

```
https://github.com/zarazhangrui/tab-out
```

The agent will walk you through it. Takes about 1 minute.

---

## Features

- **See all your tabs at a glance** on a clean grid, grouped by domain
- **Switch grouping modes** between Domain and Type without reloading the page
- **Organize quick links** with custom groups, drag sorting, and cross-group moves
- **Homepages group** pulls Gmail inbox, X home, YouTube, LinkedIn, GitHub homepages into one card
- **Close tabs with style** with swoosh sound + confetti burst
- **Duplicate detection** flags when you have the same page open twice, with one-click cleanup
- **Click any tab to jump to it** across windows, no new tab opened
- **Save for later** bookmark tabs to a checklist before closing them
- **Localhost grouping** shows port numbers next to each tab so you can tell your vibe coding projects apart
- **Expandable groups** show the first 8 tabs with a clickable "+N more"
- **Local-first classification** known sites are categorized without network requests
- **Pure Chrome extension** no server, no Node.js, no npm, no setup beyond loading the extension

---

## Manual Setup

**1. Clone the repo**

```bash
git clone https://github.com/zarazhangrui/tab-out.git
```

**2. Load the Chrome extension**

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Navigate to the `extension/` folder inside the cloned repo and select it

**3. Open a new tab**

You'll see Tab Out.

---

## How it works

```
You open a new tab
  -> Tab Out shows your open tabs grouped by domain by default
  -> Switch to Type to group sites as AI Tools, Video, Development, and more
  -> Homepages (Gmail, X, etc.) get their own group at the top
  -> Click any tab title to jump to it
  -> Close groups you're done with (swoosh + confetti)
  -> Save tabs for later before closing them
```

Everything runs inside the Chrome extension. Saved tabs are stored in `chrome.storage.local`; AI category results are cached in IndexedDB. When optional DeepSeek classification is enabled, only unknown hostnames are sent to the configured DeepSeek API.

### Optional DeepSeek classification

Add the following to `extension/config.local.js` to classify domains not covered by local rules:

```js
globalThis.DEEPSEEK_API_KEY = 'your-api-key';
globalThis.DEEPSEEK_MODEL = 'deepseek-chat';
```

Without an API key, unknown sites stay in the `Other` category and no classification request is made.

---

## Tech stack

| What | How |
|------|-----|
| Extension | Chrome Manifest V3 |
| Storage | chrome.storage.local + IndexedDB |
| Sound | Web Audio API (synthesized, no files) |
| Animations | CSS transitions + JS confetti particles |

---

## License

MIT

---

Built by [Zara](https://x.com/zarazhangrui)
