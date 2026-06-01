---
name: tdai-memory-search
description: Search long-term memory for user preferences, facts, prior conversations, and personal context. Use when the injected memory context doesn't answer the user's question about themselves, their preferences, their hardware, their projects, or anything personal/historical.
allowed-tools: [Bash]
---

# TDAI Memory Search

You have access to a long-term memory system via the TDAI gateway at `http://127.0.0.1:8421`. Use this skill when:

- The user asks about themselves (preferences, hardware, history, opinions)
- The injected context (persona/scenes) doesn't contain the specific answer
- You need to verify or find details about prior conversations
- The user references something they told you before

## Available Search Endpoints

### 1. Conversation Search (L0 — raw message history)

Searches raw past messages using hybrid keyword + semantic matching. Best for finding **specific statements** the user made.

```bash
curl -s -X POST http://127.0.0.1:8421/search/conversations \
  -H "Content-Type: application/json" \
  -d '{"query":"<your search terms>","limit":5}'
```

**Tips for effective queries:**
- Use the **likely words the user would have used** when stating the fact, not the question form
- Example: To find what GPU they have, search for GPU brand/model names: `"Intel Arc GPU graphics card"` or `"nvidia AMD GPU"` — not `"what GPU do they have"`
- Use multiple short searches with different keyword angles rather than one long query
- Keyword overlap matters: the search uses both keywords (FTS5) and embedding vectors

### 2. Memory Search (L1 — structured knowledge atoms)

Searches extracted knowledge atoms (facts, preferences, decisions). Best for **established facts** that have been processed by the extraction pipeline.

```bash
curl -s -X POST http://127.0.0.1:8421/search/memories \
  -H "Content-Type: application/json" \
  -d '{"query":"<your search terms>","limit":5}'
```

## Search Strategy

1. **Start with L1 memory search** — it has structured, deduplicated facts
2. **Fall back to L0 conversation search** if L1 doesn't have the answer — it has everything the user ever said
3. **Rephrase and retry** — if "GPU" doesn't find it, try "graphics card", "Arc", "nvidia", etc.
4. **Limit total searches to 3** per user question to avoid excessive latency

## Example Usage

User asks: "What GPU do I have?"

```bash
# Search 1: L1 for structured facts about hardware
curl -s -X POST http://127.0.0.1:8421/search/memories \
  -H "Content-Type: application/json" \
  -d '{"query":"GPU graphics card hardware","limit":5}'

# Search 2: L0 for raw statements about GPU/graphics
curl -s -X POST http://127.0.0.1:8421/search/conversations \
  -H "Content-Type: application/json" \
  -d '{"query":"Arc nvidia AMD GPU using","limit":5}'
```

## Important Notes

- The gateway runs locally at `127.0.0.1:8421` — no API key needed
- Results are JSON with a `results` field containing formatted text
- Do NOT search more than 3 times per user question
- If no results found after 3 searches, tell the user the information isn't in memory
- Always report what you found, never fabricate memory content
