const axios = require("axios");
const Anthropic = require("@anthropic-ai/sdk");

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const PDL_API_KEY = process.env.PDL_API_KEY;

function safe(val) {
  if (!val) return "";
  if (typeof val === "string") return val;
  if (Array.isArray(val)) return val.join(", ");
  return String(val);
}

async function analyzeJobAd(jobAd) {
  var prompt = "Du är en rekryterings-AI. Läs jobbannonsen nedan och returnera ENBART giltig JSON med exakt dessa fält:\n" +
    '{"title": string, "seniority": string, "industry": string, "location": string, "country": string, "yearsExperience": number, "education": string, "leadership": string, "skills": string[], "technologies": string[], "languages": string[], "certifications": string[], "similarTitles": string[], "keywords": string[]}\n' +
    "VIKTIGT: country MÅSTE vara på engelska (sweden, norway, germany, etc). Svara på svenska för andra fält men använd engelska för skills/technologies/keywords/country så PDL kan söka på dem. Annons:\n" +
    '"""' + jobAd.slice(0, 4000) + '"""';

  var response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1000,
    messages: [{ role: "user", content: prompt }],
  });

  var text = response.content[0].text.trim();
  text = text.replace(/```json|```/g, "").trim();
  var analysis = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  return analysis;
}

async function searchCandidates(analysis) {
  var titleTerms = [analysis.title].concat(analysis.similarTitles || []).filter(Boolean).slice(0, 4);

  var country = safe(analysis.country || "sweden").toLowerCase();
  if (country === "sverige") country = "sweden";
  if (country === "tyskland") country = "germany";
  if (country === "norge") country = "norway";
  if (country === "danmark") country = "denmark";

  var titleConditions = titleTerms.map(function(t) { return "job_title='" + safe(t).replace(/'/g, "") + "'"; }).join(" OR ");
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

    var scored = [];
    for (var i = 0; i < rawCandidates.length; i++) {
      var result = scorePerson(rawCandidates[i], analysis);
      if (result !== null) scored.push(result);
    }
    scored.sort(function(a, b) { return (b.matchScore + b.oppScore * 0.35) - (a.matchScore + a.oppScore * 0.35); });
    return scored.slice(0, 20);
  } catch (error) {
    console.error("PDL API error:", error.response ? error.response.data : error.message);

    if (error.response && error.response.status === 404) {
      console.log("No results, trying broader search...");
      return await broaderSearch(analysis, country);
    }

    throw new Error("Kunde inte hämta kandidater: " + (error.response ? JSON.stringify(error.response.data) : error.message));
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

    var scored = [];
    for (var i = 0; i < rawCandidates.length; i++) {
      var result = scorePerson(rawCandidates[i], analysis);
      if (result !== null) scored.push(result);
    }
    scored.sort(function(a, b) { return (b.matchScore + b.oppScore * 0.35) - (a.matchScore + a.oppScore * 0.35); });
    return scored.slice(0, 20);
  } catch (error) {
    console.error("Broader search also failed:", error.response ? error.response.data : error.message);
    return [];
  }
}

function scorePerson(person, analysis) {
  try {
    var personSkillsRaw = person.skills || [];
    var personSkills = [];
    for (var i = 0; i < personSkillsRaw.length; i++) {
      var s = personSkillsRaw[i];
      var val = typeof s === "string" ? s : (s && s.name ? s.name : "");
      personSkills.push(safe(val).toLowerCase());
    }

    var personTitle = safe(person.job_title).toLowerCase();
    var personLocation = safe(person.location_name).toLowerCase();
    var personExperience = person.inferred_years_experience || 0;
    var personCompany = safe(person.job_company_name);
    var currentJob = person.experience && person.experience.length > 0 ? person.experience[0] : null;
    var tenureYears = currentJob ? calculateTenure(currentJob.start_date) : 0;

    var requiredSkills = (analysis.skills || []).concat(analysis.technologies || []);
    var requiredLower = [];
    for (var j = 0; j < requiredSkills.length; j++) {
      requiredLower.push(safe(requiredSkills[j]).toLowerCase());
    }

    var matchedSkills = [];
    for (var k = 0; k < requiredLower.length; k++) {
      var skill = requiredLower[k];
      for (var m = 0; m < personSkills.length; m++) {
        if (personSkills[m].indexOf(skill) !== -1 || skill.indexOf(personSkills[m]) !== -1) {
          matchedSkills.push(requiredSkills[k]);
          break;
        }
      }
    }

    var skillScore = requiredLower.length > 0 ? matchedSkills.length / requiredLower.length : 0.5;
    var wantedYears = analysis.yearsExperience || 5;
    var expScore = Math.min(personExperience / wantedYears, 1);

    var wantedLocation = safe(analysis.location).toLowerCase();
    var locScore = 0.5;
    if (wantedLocation && personLocation.indexOf(wantedLocation) !== -1) locScore = 1;

    var titleTerms = [analysis.title].concat(analysis.similarTitles || []);
    var titleScore = 0.4;
    for (var n = 0; n < titleTerms.length; n++) {
      var tt = safe(titleTerms[n]).toLowerCase();
      var firstWord = tt.split(" ")[0];
      if (firstWord && personTitle.indexOf(firstWord) !== -1) {
        titleScore = 1;
        break;
      }
    }

    var rawMatch = (skillScore * 0.40) + (expScore * 0.20) + (locScore * 0.20) + (titleScore * 0.20);
    var matchScore = Math.round(Math.min(Math.max(rawMatch * 100, 40), 98));

    var tenureFit = tenureYears >= 2 && tenureYears <= 4 ? 1 : tenureYears < 2 ? tenureYears / 2 : Math.max(0.2, 1 - (tenureYears - 4) / 6);
    var oppScore = Math.round(Math.min(Math.max((tenureFit * 0.50 + skillScore * 0.30 + expScore * 0.20) * 100, 35), 97));

    var reasonParts = [];
    if (personExperience > 0) reasonParts.push(personExperience + " års erfarenhet inom " + safe(analysis.industry || "branschen"));
    if (matchedSkills.length > 0) reasonParts.push("matchar " + matchedSkills.length + " efterfrågade kompetenser (" + matchedSkills.slice(0, 3).join(", ") + ")");
    if (tenureYears >= 2 && tenureYears <= 4) reasonParts.push("befinner sig i bytesfönstret (" + tenureYears.toFixed(1) + " år)");
    if (person.job_company_name) reasonParts.push("arbetar på " + safe(person.job_company_name));
    var reason = reasonParts.length > 0 ? reasonParts.join(", ") + "." : "Kandidaten matchar kravprofilen.";

    var history = [];
    var expList = person.experience || [];
    for (var p = 0; p < Math.min(expList.length, 4); p++) {
      var exp = expList[p];
      history.push({
        company: safe(exp.company && exp.company.name ? exp.company.name : exp.company) || "Okänt företag",
        title: safe(exp.title && exp.title.name ? exp.title.name : exp.title) || "Okänd roll",
        from: exp.start_date ? exp.start_date.slice(0, 4) : "?",
        to: exp.end_date ? exp.end_date.slice(0, 4) : null,
        current: !exp.end_date,
      });
    }

    var strengths = [];
    if (matchedSkills.length >= 3) strengths.push("Stark kompetensmatchning – täcker " + matchedSkills.slice(0, 4).join(", ") + ".");
    if (personExperience >= (analysis.yearsExperience || 5)) strengths.push("Gedigen erfarenhet (" + personExperience + " år).");
    if (person.linkedin_url) strengths.push("Verifierbar LinkedIn-profil tillgänglig.");
    if (strengths.length === 0) strengths.push("Profilen matchar grundkraven för rollen.");

    var weaknesses = [];
    if (wantedLocation && personLocation.indexOf(wantedLocation) === -1) {
      weaknesses.push("Bor i " + safe(person.location_locality || person.location_name) + " – kan kräva pendling till " + safe(analysis.location) + ".");
    }
    var allRequired = (analysis.skills || []).concat(analysis.technologies || []);
    var missingSkills = [];
    for (var q = 0; q < allRequired.length && missingSkills.length < 2; q++) {
      var found = false;
      for (var r = 0; r < matchedSkills.length; r++) {
        if (matchedSkills[r].toLowerCase() === allRequired[q].toLowerCase()) { found = true; break; }
      }
      if (!found) missingSkills.push(allRequired[q]);
    }
    if (missingSkills.length > 0) weaknesses.push("Kompetens inom " + missingSkills.join(" och ") + " framgår inte tydligt.");
    if (weaknesses.length === 0) weaknesses.push("Inga väsentliga svagheter identifierade.");

    var displaySkills = [];
    for (var x = 0; x < Math.min(personSkills.length, 8); x++) {
      displaySkills.push(capitalize(personSkills[x]));
    }

    return {
      id: person.id || Math.random().toString(36).slice(2),
      name: safe(person.full_name) || "Okänt namn",
      title: safe(person.job_title) || "Okänd titel",
      company: personCompany || "Okänt företag",
      city: safe(person.location_locality || person.location_name) || "Okänd ort",
      years: personExperience,
      tenure: tenureYears,
      skills: displaySkills,
      education: formatEducation(person.education),
      matchScore: matchScore,
      oppScore: oppScore,
      matchedSkills: matchedSkills,
      linkedin: person.linkedin_url || null,
      reason: reason,
      history: history,
      languages: [],
      strengths: strengths,
      weaknesses: weaknesses,
    };
  } catch (e) {
    console.error("Error scoring person:", e.message);
    return null;
  }
}

function calculateTenure(startDate) {
  if (!startDate) return 0;
  try {
    var start = new Date(startDate);
    var now = new Date();
    return Math.max(0, (now - start) / (1000 * 60 * 60 * 24 * 365));
  } catch (e) {
    return 0;
  }
}

function formatEducation(educationArray) {
  if (!educationArray || educationArray.length === 0) return "Ej angiven";
  var edu = educationArray[0];
  var degree = "";
  var school = "";
  try { degree = safe(edu.degrees ? edu.degrees[0] : (edu.degree || "")); } catch(e) {}
  try { school = safe(edu.school ? (edu.school.name || edu.school) : ""); } catch(e) {}
  if (degree && school) return degree + ", " + school;
  return school || degree || "Ej angiven";
}

function capitalize(str) {
  var s = safe(str);
  if (!s) return "";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

module.exports = { analyzeJobAd, searchCandidates };