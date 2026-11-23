# Archisys MCP server

This lets an AI assistant work with Archisys for you. Ask it to draw a rate limiter, or to read your code and turn the architecture into a design, and it builds the design, runs it through the same simulation engine as Archisys, and comes back with real numbers: where the latency goes, what saturates first, what fails and why. It also gives you a link that opens the design straight in your browser.

In assistants that support [MCP Apps](https://modelcontextprotocol.io/docs/extensions/apps) the design also opens as a live Archisys canvas right in the chat. You can press play, drag the traffic up, move things around, and whatever you change goes back to the assistant, so its next edit starts from what you are looking at.

| Tool            | What it does                                                                                |
| --------------- | ------------------------------------------------------------------------------------------- |
| `read_me`       | The design format, every component and setting, and how real code maps onto components      |
| `create_view`   | Validates a design, simulates 30 seconds of it, and shows it on the canvas                  |
| `export_design` | Returns the design as a `.archisys` file, which the app and the VS Code extension can open  |
| `open_design`   | Reads an Archisys share link back into a design, so you can ask for changes to it           |

## Connect your assistant

There are two ways in, and both give you the same tools.

- **The hosted server**, `https://mcp.archisys.dev/mcp`. Nothing to install and nothing to run: add the URL and ask.
- **On your own machine**, with `npx -y archisys-mcp --stdio`. It needs [Node](https://nodejs.org) 20 or newer, and the simulation then runs on your computer.

Which assistants draw the canvas in the chat, according to the [MCP client matrix](https://modelcontextprotocol.io/extensions/client-matrix):

| Canvas in the chat                                             | Numbers and a link only                               |
| -------------------------------------------------------------- | ----------------------------------------------------- |
| claude.ai, Claude Desktop, VS Code with Copilot, Cursor, Goose | Claude Code, Codex, Gemini CLI, Windsurf / Devin, Zed |

### claude.ai and Claude Desktop

Go to **Customize > Connectors > Add custom connector**, name it `Archisys`, and enter `https://mcp.archisys.dev/mcp`. There is no sign-in, so leave the OAuth fields empty. On a Team or Enterprise plan an owner adds it first under **Organization settings > Connectors**.

To run it locally in Claude Desktop instead, open **Settings > Developer > Edit Config**, add this, and restart the app completely:

```json
{
  "mcpServers": {
    "archisys": {
      "command": "node",
      "args": ["c:/Users/saabi/OneDrive/Documents/code/projects/Archi-Sys/Archi-Sys/mcp/dist/index.js", "--stdio"]
    }
  }
}
```

### Claude Code

```bash
claude mcp add --transport http --scope user archisys https://mcp.archisys.dev/mcp
```

or, to run it locally:

```bash
claude mcp add --scope user archisys -- node c:/Users/saabi/OneDrive/Documents/code/projects/Archi-Sys/Archi-Sys/mcp/dist/index.js --stdio
```

`--scope user` makes it available in every project, which is what you want for "read my code and turn it into a design". Without it the server is only added for the folder you ran the command in. Run `/mcp` inside Claude Code to check it connected, and `claude mcp remove archisys --scope user` to take it out again.

To share it with everyone working in one repo, put this in `.mcp.json` at the repo root:

```json
{
  "mcpServers": {
    "archisys": {
      "type": "http",
      "url": "https://mcp.archisys.dev/mcp"
    }
  }
}
```

### VS Code with GitHub Copilot

From a terminal:

```bash
code --add-mcp '{"name":"archisys","type":"http","url":"https://mcp.archisys.dev/mcp"}'
```

Or run **MCP: Add Server** from the command palette, choose HTTP, enter the URL, and pick Global to have it everywhere. For one workspace only, put this in `.vscode/mcp.json` (the key is `servers`, not `mcpServers`):

```json
{
  "servers": {
    "archisys": {
      "type": "http",
      "url": "https://mcp.archisys.dev/mcp"
    }
  }
}
```

To run it locally, use `"type": "stdio", "command": "node", "args": ["c:/Users/saabi/OneDrive/Documents/code/projects/Archi-Sys/Archi-Sys/mcp/dist/index.js", "--stdio"]` in place of the type and URL. Then ask in Copilot Chat in agent mode. The canvas appears inline when the setting `chat.mcp.apps.enabled` is on.

### Cursor

Put this in `~/.cursor/mcp.json` for every project, or `.cursor/mcp.json` for one:

```json
{
  "mcpServers": {
    "archisys": {
      "url": "https://mcp.archisys.dev/mcp"
    }
  }
}
```

To run it locally, use `"type": "stdio", "command": "node", "args": ["c:/Users/saabi/OneDrive/Documents/code/projects/Archi-Sys/Archi-Sys/mcp/dist/index.js", "--stdio"]` in place of the URL.

### Antigravity

In `~/.gemini/config/mcp_config.json`:

```json
{
  "mcpServers": {
    "archisys": {
      "url": "http://localhost:3001/mcp"
    }
  }
}
```

Or for stdio:

```json
{
  "mcpServers": {
    "archisys": {
      "command": "node",
      "args": ["c:/Users/saabi/OneDrive/Documents/code/projects/Archi-Sys/Archi-Sys/mcp/dist/index.js", "--stdio"]
    }
  }
}
```

### Anything else

Anything that speaks MCP over HTTP can use `https://mcp.archisys.dev/mcp`, and anything that starts servers itself can run `node mcp/dist/index.js --stdio`. Without `--stdio` the server serves Streamable HTTP at `http://localhost:3001/mcp` instead: `PORT` changes the port, `HOST` the address it binds to, and `ALLOWED_HOSTS` adds hostnames it will answer to besides localhost.

## Things to try

- "Make a rate limiter diagram in Archisys."
- "Read this repo and turn its architecture into an Archisys design. Tell me which numbers you had to guess."
- "Double the traffic. What breaks first?" and then "Fix it without adding more servers."
- "Save it as an .archisys file."

To open a saved `.archisys` file, use **Settings > Open a file** in the Archisys app. Opening the file directly in an editor shows its JSON.

## Working on it

```bash
cd mcp
bun install
bun run build
```

That produces `dist/index.js`, one file with the canvas and the engine inside it. Point an assistant at it with `node /path/to/Archi-Sys/mcp/dist/index.js --stdio` to try your changes.

The server imports the engine and the app straight from `../src`, so there is no second copy of anything. `widget/` is the canvas a chat host draws: the whole app, seeded with the design through the same storage shim idea the VS Code panel uses. `bun run typecheck` checks this package, and its tests live in `src/` and run with the rest of the suite from the repo root.
