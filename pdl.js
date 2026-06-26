const axios = require("axios");
const Anthropic = require("@anthropic-ai/sdk");

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const PDL_API_KEY = process.env.PDL_API_KEY;

function safe(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(safe).filter(Boolean).join(", ");
  if (typeof value === "object") {
    return (
      value.name ||
      value.title ||
      value.locality ||
      value.country ||
      value.value ||
      ""
    );
  }
  return "";
}

function cleanSql(value) {
  return safe(value).replace(/'/g, "").trim();
}

function normalizeCountry(country) {
  let c = safe(country || "sweden").toLowerCase();

  const map = {
    sverige: "sweden",
    sweden: "sweden",
    se: "sweden",
    norge: "norway",
    norway: "norway",
    danmark: "denmark",
    denmark: "denmark",
    tyskland: "germany",
    germany: "germany",
  };

  return map[c] || c;
}

async function analyzeJobAd(jobAd) {
  const prompt =
    "Du är en rekryterings-AI. Läs jobbannonsen nedan och returnera ENBART giltig JSON med exakt dessa fält:\n" +
    '{"title": string, "seniority": string, "industry": string, "location": string, "country": string, "yearsExperience": number, "education": string, "leadership": string, "skills": string[], "technologies": string[], "languages": string[], "certifications": string[], "similarTitles": string[], "keywords": string[]}\n' +
    "VIKTIGT: country MÅSTE vara på engelska, t.ex. sweden, norway, germany. Använd engelska för skills, technologies och keywords så People Data Labs kan söka bättre. Annons:\n" +
    '"""' +
    safe(jobAd).slice(0, 4000) +
    '"""';

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1000,
    messages: [{ role: "user", content: prompt }],
  });

  let text = response.content[0].text.trim();
  text = text.replace(/```json|```/g, "").trim();

  const jsonStart = text.indexOf("{");
  const jsonEnd = text.lastIndexOf("}");

  if (jsonStart === -1 || jsonEnd === -1) {
    throw new Error("Claude kunde inte analysera jobbannonsen som JSON.");
  }

  return JSON.parse(text.slice(jsonStart, jsonEnd + 1));
}

async function searchCandidates(analysis) {
  const country = normalizeCountry(analysis.country);

  const titleTerms = [analysis.title]
    .concat(analysis.similarTitles || [])
    .map(cleanSql)
    .filter(Boolean)
    .slice(0, 5);

  const skills = (analysis.skills || [])
    .concat(analysis.technologies || [])
    .map(cleanSql)
    .filter(Boolean)
    .slice(0, 6);

  const titleSql =
    titleTerms.length > 0
      ? "(" + titleTerms.map((t) => `job_title LIKE '%${t}%'`).join(" OR ") + ")"
      : "job_title IS NOT NULL";

  const skillSql =
    skills.length > 0
      ? " AND (" + skills.map((s) => `skills LIKE '%${s}%'`).join(" OR ") + ")"
      : "";

  const sqlQuery =
    `SELECT * FROM person WHERE location_country='${country}' AND ${titleSql}${skillSql}`;

  console.log("PDL SQL query:", sqlQuery);

  try {
    const response = await axios.post(
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

    const rawCandidates = response.data.data || [];
    console.log("PDL returned " + rawCandidates.length + " candidates");

    if (rawCandidates.length === 0) {
      return await broaderSearch(analysis, country);
    }

    return rankCandidates(rawCandidates, analysis);
  } catch (error) {
    const status = error.response?.status;
    const message = error.response?.data?.error?.message || error.message;

    console.error("PDL API error:", error.response?.data || error.message);

    if (status === 402) {
      throw new Error(
        "People Data Labs credits är slut. Du har nått maxgränsen för Person Search API. Uppgradera PDL-planen eller vänta tills credits återställs."
      );
    }

    if (status === 404) {
      return await broaderSearch(analysis, country);
    }

    throw new Error("Kunde inte hämta kandidater från People Data Labs: " + message);
  }
}

async function broaderSearch(analysis, country) {
  const sqlQuery =
    `SELECT * FROM person WHERE location_country='${country}' AND job_title IS NOT NULL`;

  console.log("Broader PDL SQL query:", sqlQuery);

  try {
    const response = await axios.post(
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

    const rawCandidates = response.data.data || [];
    console.log("Broader search returned " + rawCandidates.length + " candidates");

    return rankCandidates(rawCandidates, analysis);
  } catch (error) {
    const status = error.response?.status;

    if (status === 402) {
      throw new Error(
        "People Data Labs credits är slut. Du har nått maxgränsen för Person Search API."
      );
    }

    console.error("Broader search failed:", error.response?.data || error.message);
    return [];
  }
}

function rankCandidates(rawCandidates, analysis) {
  const scored = [];

  for (const person of rawCandidates) {
    const result = scorePerson(person, analysis);
    if (result) scored.push(result);
  }

  scored.sort(
    (a, b) =>
      b.matchScore + b.oppScore * 0.35 - (a.matchScore + a.oppScore * 0.35)
  );

  return scored.slice(0, 20);
}

function scorePerson(person, analysis) {
  try {
    const personSkillsRaw = person.skills || [];
    const personSkills = personSkillsRaw
      .map((s) => safe(typeof s === "string" ? s : s?.name || s))
      .filter(Boolean)
      .map((s) => s.toLowerCase());

    const personTitle = safe(person.job_title).toLowerCase();
    const personLocation = safe(
      person.location_name || person.location_locality || person.location_country
    ).toLowerCase();

    const personExperience = Number(person.inferred_years_experience || 0);
    const personCompany = safe(person.job_company_name);

    const currentJob =
      Array.isArray(person.experience) && person.experience.length > 0
        ? person.experience[0]
        : null;

    const tenureYears = currentJob ? calculateTenure(currentJob.start_date) : 0;

    const requiredSkills = (analysis.skills || []).concat(analysis.technologies || []);
    const requiredLower = requiredSkills.map((s) => safe(s).toLowerCase()).filter(Boolean);

    const matchedSkills = [];

    for (let i = 0; i < requiredLower.length; i++) {
      const skill = requiredLower[i];

      for (const ps of personSkills) {
        if (ps && skill && (ps.includes(skill) || skill.includes(ps))) {
          matchedSkills.push(requiredSkills[i]);
          break;
        }
      }
    }

    const skillScore =
      requiredLower.length > 0 ? matchedSkills.length / requiredLower.length : 0.5;

    const wantedYears = Number(analysis.yearsExperience || 5);
    const expScore = Math.min(personExperience / wantedYears, 1);

    const wantedLocation = safe(analysis.location).toLowerCase();
    let locScore = 0.5;

    if (wantedLocation && personLocation.includes(wantedLocation)) {
      locScore = 1;
    }

    const titleTerms = [analysis.title].concat(analysis.similarTitles || []);
    let titleScore = 0.4;

    for (const title of titleTerms) {
      const t = safe(title).toLowerCase();
      if (!t) continue;

      const firstWord = t.split(" ")[0];
      if (firstWord && personTitle.includes(firstWord)) {
        titleScore = 1;
        break;
      }
    }

    const rawMatch =
      skillScore * 0.4 + expScore * 0.2 + locScore * 0.2 + titleScore * 0.2;

    const matchScore = Math.round(Math.min(Math.max(rawMatch * 100, 40), 98));

    const tenureFit =
      tenureYears >= 2 && tenureYears <= 4
        ? 1
        : tenureYears < 2
        ? tenureYears / 2
        : Math.max(0.2, 1 - (tenureYears - 4) / 6);

    const oppScore = Math.round(
      Math.min(Math.max((tenureFit * 0.5 + skillScore * 0.3 + expScore * 0.2) * 100, 35), 97)
    );

    const reasonParts = [];

    if (personExperience > 0) {
      reasonParts.push(
        `${personExperience} års erfarenhet inom ${safe(analysis.industry || "branschen")}`
      );
    }

    if (matchedSkills.length > 0) {
      reasonParts.push(
        `matchar ${matchedSkills.length} efterfrågade kompetenser (${matchedSkills
          .slice(0, 3)
          .join(", ")})`
      );
    }

    if (tenureYears >= 2 && tenureYears <= 4) {
      reasonParts.push(`befinner sig i bytesfönstret (${tenureYears.toFixed(1)} år)`);
    }

    if (personCompany) {
      reasonParts.push(`arbetar på ${personCompany}`);
    }

    const history = (person.experience || []).slice(0, 4).map((exp) => ({
      company: safe(exp.company?.name || exp.company) || "Okänt företag",
      title: safe(exp.title?.name || exp.title) || "Okänd roll",
      from: exp.start_date ? safe(exp.start_date).slice(0, 4) : "?",
      to: exp.end_date ? safe(exp.end_date).slice(0, 4) : null,
      current: !exp.end_date,
    }));

    const strengths = [];

    if (matchedSkills.length >= 3) {
      strengths.push(
        "Stark kompetensmatchning – täcker " +
          matchedSkills.slice(0, 4).join(", ") +
          "."
      );
    }

    if (personExperience >= wantedYears) {
      strengths.push(`Gedigen erfarenhet (${personExperience} år).`);
    }

    if (person.linkedin_url) {
      strengths.push("Verifierbar LinkedIn-profil tillgänglig.");
    }

    if (strengths.length === 0) {
      strengths.push("Profilen matchar grundkraven för rollen.");
    }

    const weaknesses = [];

    if (wantedLocation && personLocation && !personLocation.includes(wantedLocation)) {
      weaknesses.push(
        `Bor i ${safe(person.location_locality || person.location_name)} – kan kräva pendling till ${safe(
          analysis.location
        )}.`
      );
    }

    const missingSkills = requiredSkills
      .filter(
        (s) =>
          !matchedSkills
            .map((m) => safe(m).toLowerCase())
            .includes(safe(s).toLowerCase())
      )
      .slice(0, 2);

    if (missingSkills.length > 0) {
      weaknesses.push(
        "Kompetens inom " + missingSkills.join(" och ") + " framgår inte tydligt."
      );
    }

    if (weaknesses.length === 0) {
      weaknesses.push("Inga väsentliga svagheter identifierade.");
    }

    return {
      id: safe(person.id) || Math.random().toString(36).slice(2),
      name: safe(person.full_name) || "Okänt namn",
      title: safe(person.job_title) || "Okänd titel",
      company: personCompany || "Okänt företag",
      city: safe(person.location_locality || person.location_name) || "Okänd ort",
      years: personExperience,
      tenure: Number(tenureYears.toFixed(1)),
      skills: personSkills.slice(0, 8).map(capitalize),
      education: formatEducation(person.education),
      matchScore,
      oppScore,
      matchedSkills,
      linkedin: person.linkedin_url || null,
      reason:
        reasonParts.length > 0
          ? reasonParts.join(", ") + "."
          : "Kandidaten matchar kravprofilen.",
      history,
      languages: formatLanguages(person.languages),
      strengths,
      weaknesses,
    };
  } catch (error) {
    console.error("Error scoring person:", error.message);
    return null;
  }
}

function calculateTenure(startDate) {
  if (!startDate) return 0;

  const start = new Date(startDate);
  if (Number.isNaN(start.getTime())) return 0;

  const now = new Date();
  return Math.max(0, (now - start) / (1000 * 60 * 60 * 24 * 365));
}

function formatEducation(educationArray) {
  if (!Array.isArray(educationArray) || educationArray.length === 0) {
    return "Ej angiven";
  }

  const edu = educationArray[0];
  const degree = safe(edu.degrees?.[0] || edu.degree || "");
  const school = safe(edu.school?.name || edu.school || "");

  if (degree && school) return `${degree}, ${school}`;
  return school || degree || "Ej angiven";
}

function formatLanguages(languages) {
  if (!Array.isArray(languages) || languages.length === 0) {
    return [];
  }

  return languages.map((l) => capitalize(safe(l.name || l))).filter(Boolean);
}

function capitalize(str) {
  const s = safe(str);
  if (!s) return "";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

module.exports = { analyzeJobAd, searchCandidates };