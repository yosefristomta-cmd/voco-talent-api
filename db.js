const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

async function saveSearch({ jobAd, analysis, candidateCount }) {
  const { error } = await supabase.from("searches").insert({
    job_ad: jobAd,
    title: analysis.title,
    location: analysis.location,
    analysis: analysis,
    candidate_count: candidateCount,
    created_at: new Date().toISOString(),
  });
  if (error) console.error("Error saving search:", error.message);
}

async function getSearchHistory() {
  const { data, error } = await supabase
    .from("searches")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw new Error(error.message);
  return data || [];
}

async function saveCandidate(candidate) {
  const { error } = await supabase.from("saved_candidates").insert({
    candidate_id: candidate.id,
    name: candidate.name,
    title: candidate.title,
    company: candidate.company,
    city: candidate.city,
    linkedin: candidate.linkedin,
    match_score: candidate.matchScore,
    opp_score: candidate.oppScore,
    skills: candidate.skills,
    data: candidate,
    note: "",
    tags: [],
    created_at: new Date().toISOString(),
  });
  if (error) throw new Error(error.message);
}

async function getSavedCandidates() {
  const { data, error } = await supabase
    .from("saved_candidates")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return data || [];
}

async function deleteCandidate(id) {
  const { error } = await supabase
    .from("saved_candidates")
    .delete()
    .eq("id", id);
  if (error) throw new Error(error.message);
}

async function updateNote(id, note) {
  const { error } = await supabase
    .from("saved_candidates")
    .update({ note })
    .eq("id", id);
  if (error) throw new Error(error.message);
}

module.exports = { saveSearch, getSearchHistory, saveCandidate, getSavedCandidates, deleteCandidate, updateNote };