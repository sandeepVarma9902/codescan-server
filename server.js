/**
 * CodeScan Proxy Server — with MIPS PDF RAG
 * 
 * RAG Pipeline:
 * 1. Download official CMS PDF for the measure
 * 2. Extract full text using pdf-parse
 * 3. Cache extracted text (no re-downloads)
 * 4. AI answers from ACTUAL PDF content
 */

import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import pdfParse from "pdf-parse/lib/pdf-parse.js";

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json({ limit: "10mb" }));

// In-memory cache — PDF text cached for 7 days
const pdfCache = {};
const PDF_TTL  = 7 * 24 * 60 * 60 * 1000;

// CMS PDF URL patterns per year
const CMS_PDF_URL = (year, id) => {
  const paddedId = String(id).padStart(3, "0");
  return `https://qpp.cms.gov/docs/QPP_quality_measure_specifications/CQM-Measures/${year}_Measure_${paddedId}_MIPSCQM.pdf`;
};

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

// ── MIPS PDF RAG — Download + Extract + Cache ─────────────────────────────────
app.get("/api/cms/measure/:year/:id", async (req, res) => {
  const { year, id } = req.params;
  const cacheKey = `pdf_${year}_${id}`;

  // Return cached PDF text
  if (pdfCache[cacheKey] && Date.now() - pdfCache[cacheKey].ts < PDF_TTL) {
    console.log(`Cache hit: MIPS #${id} (${year})`);
    return res.json({ ...pdfCache[cacheKey].data, cached: true });
  }

  const pdfUrl = CMS_PDF_URL(year, id);
  console.log(`Downloading CMS PDF: ${pdfUrl}`);

  try {
    // Step 1: Download PDF from CMS
    const pdfResponse = await fetch(pdfUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; EHR-MIPS-Tool/1.0)",
        "Accept": "application/pdf,*/*",
      },
      timeout: 30000,
    });

    if (!pdfResponse.ok) {
      // PDF not found — maybe different URL format for this year
      return res.status(404).json({
        error: `PDF not found for Measure #${id} (${year}). URL tried: ${pdfUrl}`,
        id, year, pdfUrl,
        hint: "Verify the measure ID exists for this year at qpp.cms.gov"
      });
    }

    // Step 2: Extract text from PDF
    const pdfBuffer = await pdfResponse.buffer();
    const pdfData   = await pdfParse(pdfBuffer);
    const fullText  = pdfData.text;

    if (!fullText || fullText.length < 100) {
      throw new Error("PDF text extraction returned empty content");
    }

    // Step 3: Extract key sections from the text
    const sections = extractSections(fullText);

    const result = {
      id,
      year,
      pdfUrl,
      fullText: fullText.slice(0, 15000), // Cap at 15K chars for prompt size
      sections,
      pageCount: pdfData.numpages,
      charCount: fullText.length,
      fetchedAt: new Date().toISOString(),
      source: "Official CMS QPP PDF (qpp.cms.gov)",
    };

    // Cache it
    pdfCache[cacheKey] = { data: result, ts: Date.now() };
    console.log(`✅ Cached MIPS #${id} (${year}) — ${pdfData.numpages} pages, ${fullText.length} chars`);

    res.json(result);

  } catch (err) {
    console.error(`PDF fetch error: ${err.message}`);
    res.status(502).json({ error: err.message, id, year, pdfUrl });
  }
});

// ── Extract key sections from PDF text ───────────────────────────────────────
function extractSections(text) {
  const sections = {};

  const patterns = {
    measureTitle:    /MEASURE\s+TITLE[:\s]+(.+?)(?:\n|MEASURE TYPE)/si,
    measureType:     /MEASURE\s+TYPE[:\s]+(.+?)(?:\n\n|\nCOLLECTION)/si,
    description:     /DESCRIPTION[:\s]+(.+?)(?:\n\n|INSTRUCTIONS|DENOMINATOR)/si,
    denominator:     /DENOMINATOR[:\s]+(.+?)(?:DENOMINATOR\s+NOTE|NUMERATOR|EXCLUSION)/si,
    denominatorNote: /DENOMINATOR\s+NOTE[:\s]+(.+?)(?:NUMERATOR|EXCLUSION)/si,
    numerator:       /NUMERATOR[:\s]+(.+?)(?:NUMERATOR\s+NOTE|EXCLUSION|EXCEPTION|RATIO)/si,
    exclusions:      /EXCLUSION[S]?[:\s]+(.+?)(?:EXCEPTION|RATIO|CLINICAL|PERFORMANCE)/si,
    exceptions:      /EXCEPTION[S]?[:\s]+(.+?)(?:RATIO|CLINICAL|PERFORMANCE|$)/si,
    rationale:       /RATIONALE[:\s]+(.+?)(?:CLINICAL|GUIDANCE|$)/si,
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
  engine: process.env.GROQ_API_KEY ? "Groq (free)" : process.env.ANTHROPIC_API_KEY ? "Anthropic" : "No key",
  pdfCache: Object.keys(pdfCache).length + " PDFs cached",
  method: "RAG — CMS PDF download + text extraction",
}));

app.listen(PORT, () => {
  console.log(`\n⚡ CodeScan proxy → http://localhost:${PORT}`);
  console.log(`   Groq:      ${process.env.GROQ_API_KEY      ? "✅" : "❌"}`);
  console.log(`   Anthropic: ${process.env.ANTHROPIC_API_KEY ? "✅" : "❌"}`);
  console.log(`   MIPS RAG:  ✅ Downloads official CMS PDFs from qpp.cms.gov\n`);
});