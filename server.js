require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { analyzeJobAd, searchCandidates } = require("./pdl");
const { saveSearch, getSearchHistory, saveCandidate, getSavedCandidates, deleteCandidate, updateNote } = require("./db");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.json({ status: "Voco Talent API is running" });
});

app.post("/api/search", async (req, res) => {
  try {
    const { jobAd } = req.body;
    if (!jobAd) return res.status(400).json({ error: "jobAd is required" });

    console.log("Analyzing job ad...");
    const analysis = await analyzeJobAd(jobAd);

    console.log("Searching PDL for candidates...");
    const candidates = await searchCandidates(analysis);

    await saveSearch({ jobAd, analysis, candidateCount: candidates.length });

    res.json({ analysis, candidates });
  } catch (error) {
    console.error("Search error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/history", async (req, res) => {
  try {
    const history = await getSearchHistory();
    res.json(history);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/candidates/save", async (req, res) => {
  try {
    const candidate = req.body;
    await saveCandidate(candidate);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/candidates/saved", async (req, res) => {
  try {
    const candidates = await getSavedCandidates();
    res.json(candidates);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete("/api/candidates/:id", async (req, res) => {
  try {
    await deleteCandidate(req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.patch("/api/candidates/:id/note", async (req, res) => {
  try {
    const { note } = req.body;
    await updateNote(req.params.id, note);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Voco Talent API running on port ${PORT}`);
});