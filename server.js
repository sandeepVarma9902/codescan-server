/**
 * apps/web/server.js
 * Proxy server — supports Groq (free) and Anthropic (paid)
 * Run: node server.js
 */

import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.post("/api/review", async (req, res) => {
  const groqKey      = process.env.GROQ_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  if (groqKey) {
    // ── Groq (FREE) ────────────────────────────────────────────────────────
    try {
      const { messages, max_tokens } = req.body;
      const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${groqKey}`,
        },
        body: JSON.stringify({
          model: "llama-3.3-70b-versatile",
          messages,
          max_tokens: max_tokens || 4000,
          temperature: 0.1,
        }),
      });

      const data = await response.json();
      if (!response.ok) return res.status(response.status).json(data);

      // Convert Groq response format → Anthropic format so frontend works unchanged
      const text = data.choices?.[0]?.message?.content || "";
      res.json({ content: [{ type: "text", text }] });

    } catch (err) {
      res.status(500).json({ error: err.message });
    }

  } else if (anthropicKey) {
    // ── Anthropic (PAID) ───────────────────────────────────────────────────
    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": anthropicKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(req.body),
      });

      const data = await response.json();
      if (!response.ok) return res.status(response.status).json(data);
      res.json(data);

    } catch (err) {
      res.status(500).json({ error: err.message });
    }

  } else {
    res.status(400).json({
      error: "No API key set. Run: export GROQ_API_KEY=gsk_xxx  or  export ANTHROPIC_API_KEY=sk-ant-xxx"
    });
  }
});

app.get("/health", (_, res) => {
  res.json({
    status: "ok",
    engine: process.env.GROQ_API_KEY ? "Groq (free)" : process.env.ANTHROPIC_API_KEY ? "Anthropic" : "No key set",
  });
});

app.listen(PORT, () => {
  const groqKey      = process.env.GROQ_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  console.log(`\n⚡ CodeScan proxy → http://localhost:${PORT}`);
  console.log(`   Groq:      ${groqKey      ? "✅ Active (free)" : "❌ Not set"}`);
  console.log(`   Anthropic: ${anthropicKey ? "✅ Active"        : "❌ Not set"}`);
  if (!groqKey && !anthropicKey) {
    console.log(`\n   ⚠️  Set a key:\n   export GROQ_API_KEY=gsk_xxx\n`);
  }
});