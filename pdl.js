const axios = require("axios");
const Anthropic = require("@anthropic-ai/sdk");

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const PDL_API_KEY = process.env.PDL_API_KEY;

async function analyzeJobAd(jobAd) {
  const prompt = `Du är en rekryterings-AI. Läs jobbannonsen nedan och returnera ENBART giltig JSON med exakt dessa fält:
{"title": string, "seniority": string, "industry": string, "location": string, "country": string, "yearsExperience": number, "education": string, "leadership": string, "skills": string[], "technologies": string[], "languages": string[], "certifications": string[], "similarTitles": string[], "keywords": string[]}
Svara på svenska för label-fält men använd engelska för skills/technologies/keywords så PDL kan söka på dem. Annons:
"""${jobAd.slice(0, 4000)}"""`;

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1000,
    messages: [{ role: "user", content: prompt }],
  });

  let text = response.content[0].text.trim();
  text = text.replace(/```json|```/g, "").trim();
  const analysis = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  return analysis;
}

async function searchCandidates(analysis) {
  const mustClauses = [];

  if (analysis.location) {
    mustClauses.push({
      term: { "location_country": analysis.country || "sweden" }
    });
  }

  const titleTerms = [analysis.title, ...(analysis.similarTitles || [])].filter(Boolean).slice(0, 3);
  if (titleTerms.length > 0) {
    mustClauses.push({
      bool: {
        should: titleTerms.map(t => ({
          match: { "job_title": t }
        }))
      }
    });
  }

  const query = {
    bool: {
      must: mustClauses.length > 0 ? mustClauses : [{ match_all: {} }]
    }
  };

  try {
    const response = await axios.post(
      "https://api.peopledatalabs.com/v5/person/search",
      {
        query,
        size: 25,
        pretty: true,
        dataset: "all",
      },
      {
        headers: {
          "X-Api-Key": PDL_API_KEY,
          "Content-Type": "application/json",
        },
      }
    );

    const rawCandidates = response.data.data || [];
    console.log(`PDL returned ${rawCandidates.length} candidates`);

    const scored = rawCandidates
      .map(person => scorePerson(person, analysis))
      .filter(c => c !== null)
      .sort((a, b) => (b.matchScore + b.oppScore * 0.35) - (a.matchScore + a.oppScore * 0.35))
      .slice(0, 20);

    return scored;
  } catch (error) {
    console.error("PDL API error:", error.response?.data || error.message);
    throw new Error("Kunde inte hämta kandidater från People Data Labs: " + (error.response?.data?.error?.message || error.message));
  }
}

function scorePerson(person, analysis) {
  try {
    const personSkills = (person.skills || []).map(s => s.name?.toLowerCase() || "");
    const personTitle = (person.job_title || "").toLowerCase();
    const personLocation = (person.location_name || "").toLowerCase();
    const personExperience = person.inferred_years_experience || 0;
    const personCompany = person.job_company_name || "";
    const currentJob = person.experience?.[0];
    const tenureYears = currentJob ? calculateTenure(currentJob.start_date) : 0;

    const requiredSkills = [
      ...(analysis.skills || []),
      ...(analysis.technologies || [])
    ].map(s => s.toLowerCase());

    const matchedSkills = requiredSkills.filter(skill =>
      personSkills.some(ps => ps.includes(skill) || skill.includes(ps))
    );
    const skillScore = requiredSkills.length > 0
      ? matchedSkills.length / requiredSkills.length
      : 0.5;

    const wantedYears = analysis.yearsExperience || 5;
    const expScore = Math.min(personExperience / wantedYears, 1);

    const wantedLocation = (analysis.location || "").toLowerCase();
    const locScore = personLocation.includes(wantedLocation) ||
      wantedLocation.includes(personLocation.split(",")[0]) ? 1 : 0.5;

    const titleTerms = [analysis.title, ...(analysis.similarTitles || [])]
      .map(t => t.toLowerCase());
    const titleScore = titleTerms.some(t =>
      personTitle.includes(t.split(" ")[0]) || t.includes(personTitle.split(" ")[0])
    ) ? 1 : 0.4;

    const rawMatch = (skillScore * 0.40) + (expScore * 0.20) + (locScore * 0.20) + (titleScore * 0.20);
    const matchScore = Math.round(Math.min(Math.max(rawMatch * 100, 40), 98));

    const tenureFit = tenureYears >= 2 && tenureYears <= 4 ? 1
      : tenureYears < 2 ? tenureYears / 2
      : Math.max(0.2, 1 - (tenureYears - 4) / 6);
    const oppScore = Math.round(Math.min(Math.max(
      (tenureFit * 0.50 + skillScore * 0.30 + expScore * 0.20) * 100, 35
    ), 97));

    const reason = buildReason(person, analysis, matchedSkills, personExperience, tenureYears);

    const history = (person.experience || []).slice(0, 4).map(exp => ({
      company: exp.company?.name || exp.company || "Okänt företag",
      title: exp.title?.name || exp.title || "Okänd roll",
      from: exp.start_date?.slice(0, 4) || "?",
      to: exp.end_date?.slice(0, 4) || null,
      current: !exp.end_date,
    }));

    return {
      id: person.id || Math.random().toString(36).slice(2),
      name: person.full_name || "Okänt namn",
      title: person.job_title || "Okänd titel",
      company: personCompany || "Okänt företag",
      city: person.location_locality || person.location_name || "Okänd ort",
      years: personExperience,
      tenure: tenureYears,
      skills: personSkills.slice(0, 8).map(s => capitalize(s)),
      education: formatEducation(person.education),
      matchScore,
      oppScore,
      matchedSkills: matchedSkills.map(s => capitalize(s)),
      linkedin: person.linkedin_url || null,
      reason,
      history,
      languages: person.languages?.map(l => capitalize(l.name || l)) || ["Svenska", "Engelska"],
      strengths: buildStrengths(person, analysis, matchedSkills, personExperience),
      weaknesses: buildWeaknesses(person, analysis, matchedSkills, personLocation),
    };
  } catch (e) {
    console.error("Error scoring person:", e.message);
    return null;
  }
}

function calculateTenure(startDate) {
  if (!startDate) return 0;
  const start = new Date(startDate);
  const now = new Date();
  return Math.max(0, (now - start) / (1000 * 60 * 60 * 24 * 365));
}

function formatEducation(educationArray) {
  if (!educationArray || educationArray.length === 0) return "Ej angiven";
  const edu = educationArray[0];
  const degree = edu.degrees?.[0] || edu.degree || "";
  const school = edu.school?.name || edu.school || "";
  if (degree && school) return `${degree}, ${school}`;
  return school || degree || "Ej angiven";
}

function capitalize(str) {
  if (!str) return "";
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function buildReason(person, analysis, matchedSkills, years, tenure) {
  const parts = [];
  if (years > 0) parts.push(`${years} års erfarenhet inom ${analysis.industry || "branschen"}`);
  if (matchedSkills.length > 0) parts.push(`matchar ${matchedSkills.length} efterfrågade kompetenser (${matchedSkills.slice(0, 3).join(", ")})`);
  if (tenure >= 2 && tenure <= 4) parts.push(`befinner sig i bytesfönstret (${tenure.toFixed(1)} år på nuvarande arbetsgivare)`);
  if (person.job_company_name) parts.push(`arbetar för närvarande på ${person.job_company_name}`);
  return parts.length > 0 ? parts.join(", ") + "." : "Kandidaten matchar kravprofilen.";
}

function buildStrengths(person, analysis, matchedSkills, years) {
  const s = [];
  if (matchedSkills.length >= 3) s.push(`Stark kompetensmatchning – täcker ${matchedSkills.slice(0, 4).join(", ")}.`);
  if (years >= (analysis.yearsExperience || 5)) s.push(`Gedigen erfarenhet (${years} år), uppfyller kravet.`);
  if (person.linkedin_url) s.push("Verifierbar LinkedIn-profil tillgänglig.");
  if (s.length === 0) s.push("Profilen matchar grundkraven för rollen.");
  return s.slice(0, 3);
}

function buildWeaknesses(person, analysis, matchedSkills, personLocation) {
  const w = [];
  const wantedLocation = (analysis.location || "").toLowerCase();
  if (personLocation && !personLocation.includes(wantedLocation) && wantedLocation) {
    w.push(`Bor i ${person.location_locality || personLocation} – kan kräva pendling till ${analysis.location}.`);
  }
  const allRequired = [...(analysis.skills || []), ...(analysis.technologies || [])];
  const missing = allRequired.filter(s => !matchedSkills.map(m => m.toLowerCase()).includes(s.toLowerCase())).slice(0, 2);
  if (missing.length > 0) w.push(`Kompetens inom ${missing.join(" och ")} framgår inte tydligt av profilen.`);
  if (w.length === 0) w.push("Inga väsentliga svagheter identifierade mot kravprofilen.");
  return w.slice(0, 3);
}

module.exports = { analyzeJobAd, searchCandidates };