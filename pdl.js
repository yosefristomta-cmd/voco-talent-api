const axios = require("axios");
const Anthropic = require("@anthropic-ai/sdk");

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const PDL_API_KEY = process.env.PDL_API_KEY;

async function analyzeJobAd(jobAd) {
  const prompt = `Du är en rekryterings-AI. Läs jobbannonsen nedan och returnera ENBART giltig JSON med exakt dessa fält:
{"title": string, "seniority": string, "industry": string, "location": string, "country": string, "yearsExperience": number, "education": string, "leadership": string, "skills": string[], "technologies": string[], "languages": string[], "certifications": string[], "similarTitles": string[], "keywords": string[]}
VIKTIGT: country MÅSTE vara på engelska (sweden, norway, germany, etc). Svara på svenska för andra fält men använd engelska för skills/technologies/keywords/country så PDL kan söka på dem. Annons:
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
  var titleTerms = [analysis.title].concat(analysis.similarTitles || []).filter(Boolean).slice(0, 4);
  var location = analysis.location || "Stockholm";

  var country = (analysis.country || "sweden").toLowerCase();
  if (country === "sverige") country = "sweden";
  if (country === "tyskland") country = "germany";
  if (country === "norge") country = "norway";
  if (country === "danmark") country = "denmark";

  var titleConditions = titleTerms.map(function(t) { return "job_title='" + t.replace(/'/g, "") + "'"; }).join(" OR ");
  var sqlQuery = "SELECT * FROM person WHERE (" + (titleConditions || "job_title='manager'") + ") AND location_country='" + country + "'";

  console.log("PDL SQL query:", sqlQuery);

  try {
    var response = await axios.post(
      "https://api.peopledatalabs.com/v5/person/search",
      {
        sql: sqlQuery,
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

    var rawCandidates = response.data.data || [];
    console.log("PDL returned " + rawCandidates.length + " candidates");

    if (rawCandidates.length === 0) {
      console.log("No candidates found, trying broader search...");
      return await broaderSearch(analysis, country);
    }

    var scored = rawCandidates
      .map(function(person) { return scorePerson(person, analysis); })
      .filter(function(c) { return c !== null; })
      .sort(function(a, b) { return (b.matchScore + b.oppScore * 0.35) - (a.matchScore + a.oppScore * 0.35); })
      .slice(0, 20);

    return scored;
  } catch (error) {
    console.error("PDL API error:", error.response ? error.response.data : error.message);

    if (error.response && error.response.status === 404) {
      console.log("No results, trying broader search...");
      return await broaderSearch(analysis, country);
    }

    throw new Error("Kunde inte hämta kandidater från People Data Labs: " + (error.response ? (error.response.data.error ? error.response.data.error.message : error.message) : error.message));
  }
}

async function broaderSearch(analysis, country) {
  var sqlQuery = "SELECT * FROM person WHERE location_country='" + country + "' AND job_title IS NOT NULL";

  console.log("Broader PDL SQL query:", sqlQuery);

  try {
    var response = await axios.post(
      "https://api.peopledatalabs.com/v5/person/search",
      {
        sql: sqlQuery,
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

    var rawCandidates = response.data.data || [];
    console.log("Broader search returned " + rawCandidates.length + " candidates");

    var scored = rawCandidates
      .map(function(person) { return scorePerson(person, analysis); })
      .filter(function(c) { return c !== null; })
      .sort(function(a, b) { return (b.matchScore + b.oppScore * 0.35) - (a.matchScore + a.oppScore * 0.35); })
      .slice(0, 20);

    return scored;
  } catch (error) {
    console.error("Broader search also failed:", error.response ? error.response.data : error.message);
    return [];
  }
}

function scorePerson(person, analysis) {
  try {
    var personSkills = (person.skills || []).map(function(s) { return (typeof s === "string" ? s : (s.name || "")).toLowerCase(); });
    var personTitle = (person.job_title || "").toLowerCase();
    var personLocation = (person.location_name || "").toLowerCase();
    var personExperience = person.inferred_years_experience || 0;
    var personCompany = person.job_company_name || "";
    var currentJob = person.experience ? person.experience[0] : null;
    var tenureYears = currentJob ? calculateTenure(currentJob.start_date) : 0;

    var requiredSkills = (analysis.skills || []).concat(analysis.technologies || []).map(function(s) { return s.toLowerCase(); });

    var matchedSkills = requiredSkills.filter(function(skill) {
      return personSkills.some(function(ps) { return ps.includes(skill) || skill.includes(ps); });
    });
    var skillScore = requiredSkills.length > 0 ? matchedSkills.length / requiredSkills.length : 0.5;

    var wantedYears = analysis.yearsExperience || 5;
    var expScore = Math.min(personExperience / wantedYears, 1);

    var wantedLocation = (analysis.location || "").toLowerCase();
    var locScore = personLocation.includes(wantedLocation) || wantedLocation.includes(personLocation.split(",")[0]) ? 1 : 0.5;

    var titleTerms = [analysis.title].concat(analysis.similarTitles || []).map(function(t) { return t.toLowerCase(); });
    var titleScore = titleTerms.some(function(t) {
      return personTitle.includes(t.split(" ")[0]) || t.includes(personTitle.split(" ")[0]);
    }) ? 1 : 0.4;

    var rawMatch = (skillScore * 0.40) + (expScore * 0.20) + (locScore * 0.20) + (titleScore * 0.20);
    var matchScore = Math.round(Math.min(Math.max(rawMatch * 100, 40), 98));

    var tenureFit = tenureYears >= 2 && tenureYears <= 4 ? 1 : tenureYears < 2 ? tenureYears / 2 : Math.max(0.2, 1 - (tenureYears - 4) / 6);
    var oppScore = Math.round(Math.min(Math.max((tenureFit * 0.50 + skillScore * 0.30 + expScore * 0.20) * 100, 35), 97));

    var reason = buildReason(person, analysis, matchedSkills, personExperience, tenureYears);

    var history = (person.experience || []).slice(0, 4).map(function(exp) {
      return {
        company: (exp.company ? (exp.company.name || exp.company) : null) || "Okänt företag",
        title: (exp.title ? (exp.title.name || exp.title) : null) || "Okänd roll",
        from: exp.start_date ? exp.start_date.slice(0, 4) : "?",
        to: exp.end_date ? exp.end_date.slice(0, 4) : null,
        current: !exp.end_date,
      };
    });

    return {
      id: person.id || Math.random().toString(36).slice(2),
      name: person.full_name || "Okänt namn",
      title: person.job_title || "Okänd titel",
      company: personCompany || "Okänt företag",
      city: person.location_locality || person.location_name || "Okänd ort",
      years: personExperience,
      tenure: tenureYears,
      skills: personSkills.slice(0, 8).map(function(s) { return capitalize(s); }),
      education: formatEducation(person.education),
      matchScore: matchScore,
      oppScore: oppScore,
      matchedSkills: matchedSkills.map(function(s) { return capitalize(s); }),
      linkedin: person.linkedin_url || null,
      reason: reason,
      history: history,
      languages: person.languages ? person.languages.map(function(l) { return capitalize(l.name || l); }) : ["Svenska", "Engelska"],
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
  var start = new Date(startDate);
  var now = new Date();
  return Math.max(0, (now - start) / (1000 * 60 * 60 * 24 * 365));
}

function formatEducation(educationArray) {
  if (!educationArray || educationArray.length === 0) return "Ej angiven";
  var edu = educationArray[0];
  var degree = (edu.degrees ? edu.degrees[0] : null) || edu.degree || "";
  var school = (edu.school ? (edu.school.name || edu.school) : null) || "";
  if (degree && school) return degree + ", " + school;
  return school || degree || "Ej angiven";
}

function capitalize(str) {
  if (!str) return "";
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function buildReason(person, analysis, matchedSkills, years, tenure) {
  var parts = [];
  if (years > 0) parts.push(years + " års erfarenhet inom " + (analysis.industry || "branschen"));
  if (matchedSkills.length > 0) parts.push("matchar " + matchedSkills.length + " efterfrågade kompetenser (" + matchedSkills.slice(0, 3).join(", ") + ")");
  if (tenure >= 2 && tenure <= 4) parts.push("befinner sig i bytesfönstret (" + tenure.toFixed(1) + " år på nuvarande arbetsgivare)");
  if (person.job_company_name) parts.push("arbetar för närvarande på " + person.job_company_name);
  return parts.length > 0 ? parts.join(", ") + "." : "Kandidaten matchar kravprofilen.";
}

function buildStrengths(person, analysis, matchedSkills, years) {
  var s = [];
  if (matchedSkills.length >= 3) s.push("Stark kompetensmatchning – täcker " + matchedSkills.slice(0, 4).join(", ") + ".");
  if (years >= (analysis.yearsExperience || 5)) s.push("Gedigen erfarenhet (" + years + " år), uppfyller kravet.");
  if (person.linkedin_url) s.push("Verifierbar LinkedIn-profil tillgänglig.");
  if (s.length === 0) s.push("Profilen matchar grundkraven för rollen.");
  return s.slice(0, 3);
}

function buildWeaknesses(person, analysis, matchedSkills, personLocation) {
  var w = [];
  var wantedLocation = (analysis.location || "").toLowerCase();
  if (personLocation && !personLocation.includes(wantedLocation) && wantedLocation) {
    w.push("Bor i " + (person.location_locality || personLocation) + " – kan kräva pendling till " + analysis.location + ".");
  }
  var allRequired = (analysis.skills || []).concat(analysis.technologies || []);
  var missing = allRequired.filter(function(s) {
    return !matchedSkills.map(function(m) { return m.toLowerCase(); }).includes(s.toLowerCase());
  }).slice(0, 2);
  if (missing.length > 0) w.push("Kompetens inom " + missing.join(" och ") + " framgår inte tydligt av profilen.");
  if (w.length === 0) w.push("Inga väsentliga svagheter identifierade mot kravprofilen.");
  return w.slice(0, 3);
}

module.exports = { analyzeJobAd, searchCandidates };