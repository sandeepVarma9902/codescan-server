/**
 * CodeScan Proxy Server
 * - AI proxy (Groq/Anthropic)
 * - CMS measures data via @cmsgov/qpp-measures-data npm package (official, bundled)
 */

import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import { getMeasuresData } from "@cmsgov/qpp-measures-data";

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json({ limit: "10mb" }));

// In-memory cache
const cache = {};

// ── AI Proxy ──────────────────────────────────────────────────────────────────
app.post("/api/review", async (req, res) => {
  const groqKey      = process.env.GROQ_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  if (groqKey) {
    try {
      const { messages, max_tokens } = req.body;
      const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${groqKey}` },
        body: JSON.stringify({ model: "llama-3.3-70b-versatile", messages, max_tokens: max_tokens || 4000, temperature: 0.1 }),
      });
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json(data);
      res.json({ content: [{ type: "text", text: data.choices?.[0]?.message?.content || "" }] });
    } catch (err) { res.status(500).json({ error: err.message }); }

  } else if (anthropicKey) {
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": anthropicKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify(req.body),
      });
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json(data);
      res.json(data);
    } catch (err) { res.status(500).json({ error: err.message }); }
  } else {
    res.status(400).json({ error: "No API key set." });
  }
});

// ── CMS Measure Lookup — from official @cmsgov/qpp-measures-data npm package ──
app.get("/api/cms/measure/:year/:id", (req, res) => {
  const { year, id } = req.params;
  const cacheKey = `${year}_${id}`;

  if (cache[cacheKey]) return res.json({ ...cache[cacheKey], cached: true });

  try {
    // getMeasuresData(year) returns ALL measures for that performance year
    const allMeasures = getMeasuresData(year);

    if (!allMeasures || !Array.isArray(allMeasures)) {
      return res.status(404).json({ error: `No measures data available for year ${year}`, id, year });
    }

    // Find specific measure by measureId
    const measure = allMeasures.find(m =>
      String(m.measureId) === String(id) ||
      String(m.qualityId) === String(id)
    );

    const result = {
      id,
      year,
      measure: measure || null,
      totalMeasures: allMeasures.length,
      fetchedAt: new Date().toISOString(),
      source: "@cmsgov/qpp-measures-data (official CMS npm package)",
    };

    cache[cacheKey] = result;
    res.json(result);

  } catch (err) {
    // Year might not be supported yet
    res.status(404).json({
      error: `Year ${year} not available in CMS package: ${err.message}`,
      id,
      year,
      hint: "Supported years: 2017–2025. 2026 data may not be published yet."
    });
  }
});

// ── List all measures for a year ──────────────────────────────────────────────
app.get("/api/cms/measures/:year", (req, res) => {
  const { year } = req.params;
  try {
    const allMeasures = getMeasuresData(year);
    res.json({
      year,
      totalMeasures: allMeasures.length,
      measures: allMeasures.map(m => ({
        measureId: m.measureId,
        title: m.title,
        measureType: m.measureType,
        isHighPriority: m.isHighPriority,
      }))
    });
  } catch (err) {
    res.status(404).json({ error: err.message, year });
  }
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get("/health", (_, res) => res.json({
  status: "ok",
  engine: process.env.GROQ_API_KEY ? "Groq (free)" : process.env.ANTHROPIC_API_KEY ? "Anthropic" : "No key",
  cmsSource: "@cmsgov/qpp-measures-data (bundled)",
  cacheEntries: Object.keys(cache).length,
}));

app.listen(PORT, () => {
  console.log(`\n⚡ CodeScan proxy → http://localhost:${PORT}`);
  console.log(`   Groq:      ${process.env.GROQ_API_KEY      ? "✅" : "❌"}`);
  console.log(`   Anthropic: ${process.env.ANTHROPIC_API_KEY ? "✅" : "❌"}`);
  console.log(`   CMS Data:  ✅ @cmsgov/qpp-measures-data (official npm package)\n`);
});