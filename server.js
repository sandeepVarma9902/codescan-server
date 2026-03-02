/**
 * CodeScan / CareCode Proxy Server
 * - Streaming SSE support for Groq (fast token-by-token response)
 * - CMS PDF download + text extraction (RAG)
 * - In-memory cache for PDFs (7 day TTL)
 */

import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import pdfParse from "pdf-parse/lib/pdf-parse.js";

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: "10mb" }));

const pdfCache = {};
const PDF_TTL  = 7 * 24 * 60 * 60 * 1000;

const CMS_PDF_URL = (year, id) =>
  `https://qpp.cms.gov/docs/QPP_quality_measure_specifications/CQM-Measures/${year}_Measure_${String(id).padStart(3,"0")}_MIPSCQM.pdf`;

// ── AI Proxy — supports both streaming and non-streaming ─────────────────────
app.post("/api/review", async (req, res) => {
  const groqKey = process.env.GROQ_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const { messages, max_tokens, stream } = req.body;

  if (groqKey) {
    try {
      const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${groqKey}`,
        },
        body: JSON.stringify({
          model: "llama-3.3-70b-versatile",
          messages,
          max_tokens: max_tokens || 800,
          temperature: 0.1,
          stream: !!stream,
        }),
      });

      if (!groqRes.ok) {
        const err = await groqRes.json().catch(() => ({}));
        return res.status(groqRes.status).json(err);
      }

      // ── STREAMING MODE — pipe SSE tokens to client ──
      if (stream) {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.flushHeaders();

        const reader = groqRes.body;
        let buffer = "";

        reader.on("data", (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split("\n");
          buffer = lines.pop(); // keep incomplete line

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const data = line.slice(6).trim();
            if (data === "[DONE]") {
              res.write("data: [DONE]\n\n");
              res.end();
              return;
            }
            try {
              const parsed = JSON.parse(data);
              const token = parsed.choices?.[0]?.delta?.content;
              if (token) {
                res.write(`data: ${JSON.stringify({ token })}\n\n`);
              }
            } catch (_) {}
          }
        });

        reader.on("end", () => {
          res.write("data: [DONE]\n\n");
          res.end();
        });

        reader.on("error", (err) => {
          console.error("Stream error:", err);
          res.end();
        });

        return;
      }

      // ── NON-STREAMING MODE — return full response ──
      const data = await groqRes.json();
      const text = data.choices?.[0]?.message?.content || "";
      return res.json({ content: [{ type: "text", text }] });

    } catch (err) {
      return res.status(500).json({ error: err.message });
    }

  } else if (anthropicKey) {
    // Anthropic doesn't need streaming changes for now
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": anthropicKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(req.body),
      });
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json(data);
      return res.json(data);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }

  } else {
    return res.status(400).json({ error: "No API key configured. Set GROQ_API_KEY or ANTHROPIC_API_KEY." });
  }
});

// ── CMS PDF RAG — Download + Extract + Cache ──────────────────────────────────
app.get("/api/cms/measure/:year/:id", async (req, res) => {
  const { year, id } = req.params;
  const cacheKey = `pdf_${year}_${id}`;

  if (pdfCache[cacheKey] && Date.now() - pdfCache[cacheKey].ts < PDF_TTL) {
    console.log(`Cache hit: MIPS #${id} (${year})`);
    return res.json({ ...pdfCache[cacheKey].data, cached: true });
  }

  const pdfUrl = CMS_PDF_URL(year, id);
  console.log(`Downloading: ${pdfUrl}`);

  try {
    const pdfResponse = await fetch(pdfUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; EHR-MIPS-Tool/1.0)",
        "Accept": "application/pdf,*/*",
      },
      timeout: 30000,
    });

    if (!pdfResponse.ok) {
      return res.status(404).json({
        error: `PDF not found for Measure #${id} (${year})`,
        pdfUrl,
        hint: "Verify the measure ID exists for this year at qpp.cms.gov",
      });
    }

    const pdfBuffer = await pdfResponse.buffer();
    const pdfData   = await pdfParse(pdfBuffer);
    const fullText  = pdfData.text;

    if (!fullText || fullText.length < 100) {
      throw new Error("PDF text extraction returned empty content");
    }

    const sections = extractSections(fullText);

    const result = {
      id, year, pdfUrl,
      fullText: fullText.slice(0, 15000),
      sections,
      pageCount: pdfData.numpages,
      charCount: fullText.length,
      fetchedAt: new Date().toISOString(),
      source: "Official CMS QPP PDF (qpp.cms.gov)",
    };

    pdfCache[cacheKey] = { data: result, ts: Date.now() };
    console.log(`✅ Cached MIPS #${id} (${year}) — ${pdfData.numpages}p, ${fullText.length} chars`);
    res.json(result);

  } catch (err) {
    console.error(`PDF error: ${err.message}`);
    res.status(502).json({ error: err.message, id, year, pdfUrl });
  }
});

// ── Extract key sections from PDF text ───────────────────────────────────────
function extractSections(text) {
  const sections = {};
  const patterns = {
    measureTitle:      /MEASURE\s+TITLE[:\s]+(.+?)(?:\n|MEASURE TYPE)/si,
    measureType:       /MEASURE\s+TYPE[:\s]+(.+?)(?:\n\n|COLLECTION)/si,
    description:       /DESCRIPTION[:\s]+(.+?)(?:\n\n|INSTRUCTIONS|DENOMINATOR)/si,
    denominator:       /DENOMINATOR[:\s]+(.+?)(?:DENOMINATOR\s+NOTE|NUMERATOR|EXCLUSION)/si,
    denominatorNote:   /DENOMINATOR\s+NOTE[:\s]+(.+?)(?:NUMERATOR|EXCLUSION)/si,
    numerator:         /NUMERATOR[:\s]+(.+?)(?:NUMERATOR\s+NOTE|EXCLUSION|EXCEPTION|RATIO)/si,
    exclusions:        /EXCLUSION[S]?[:\s]+(.+?)(?:EXCEPTION|RATIO|CLINICAL|PERFORMANCE)/si,
    exceptions:        /EXCEPTION[S]?[:\s]+(.+?)(?:RATIO|CLINICAL|PERFORMANCE|$)/si,
    submissionMethods: /SUBMISSION\s+METHOD[S]?[:\s]+(.+?)(?:\n\n|DENOMINATOR)/si,
  };
  for (const [key, pattern] of Object.entries(patterns)) {
    const match = text.match(pattern);
    if (match) sections[key] = match[1].trim().slice(0, 1000);
  }
  return sections;
}

// ── Health ────────────────────────────────────────────────────────────────────
app.get("/health", (_, res) => res.json({
  status: "ok",
  engine: process.env.GROQ_API_KEY ? "Groq (streaming)" : process.env.ANTHROPIC_API_KEY ? "Anthropic" : "No key",
  streaming: !!process.env.GROQ_API_KEY,
  pdfCache: Object.keys(pdfCache).length + " PDFs cached",
}));

app.listen(PORT, () => {
  console.log(`\n⚡ CareCode proxy → http://localhost:${PORT}`);
  console.log(`   Groq:      ${process.env.GROQ_API_KEY      ? "✅ (streaming enabled)" : "❌"}`);
  console.log(`   Anthropic: ${process.env.ANTHROPIC_API_KEY ? "✅" : "❌"}`);
  console.log(`   Streaming: ${process.env.GROQ_API_KEY      ? "✅ SSE token-by-token" : "❌"}\n`);
});