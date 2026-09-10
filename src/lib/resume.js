const SECTION_HEADING = /^(项目经历|项目经验|项目实践|教育背景|教育经历|工作经历|实习经历|专业技能|技能特长|技能|自我评价|个人总结|获奖情况|证书|荣誉)/;
const TECH_HINTS = [
  "react",
  "vue",
  "typescript",
  "python",
  "java",
  "go",
  "mysql",
  "redis",
  "sql",
  "spark",
  "hive",
  "flink",
  "docker",
  "kubernetes",
  "etl",
  "node",
  "数据分析",
  "可视化",
  "bi",
  "tableau",
  "power bi"
];

function cleanLines(raw = "") {
  return raw
    .replace(/\u0000/g, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function isSectionHeading(line) {
  return SECTION_HEADING.test(line);
}

function extractName(lines) {
  for (const line of lines) {
    const labeled = line.match(/^(?:姓名|名字|name)\s*[:：]\s*([^\s,，]+)/i);
    if (labeled) return labeled[1];
  }
  const first = lines[0] || "";
  const banned = /(简历|个人|求职|应聘|resume|curriculum|vitae)/i;
  if (
    first &&
    first.length <= 6 &&
    !banned.test(first) &&
    !/[:：,，\d]/.test(first)
  ) {
    return first;
  }
  return "未识别";
}

function extractProjects(lines) {
  const projects = [];
  let cursor = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const isTitle = /^项目\s*[:：]/.test(lines[i]);
    const isHeading = /^项目(经历|经验|实践)/.test(lines[i]);
    if (!isTitle && !isHeading) continue;
    const start = i + 1;
    if (start <= cursor) continue;
    const titleLine = isTitle ? lines[i].replace(/^项目\s*[:：]\s*/, "") : lines[i].replace(/^(项目经历|项目经验|项目实践)\s*[:：]?\s*/, "");
    const detail = [];
    let j = start;
    while (j < lines.length) {
      if (isSectionHeading(lines[j]) && !/^项目/.test(lines[j])) break;
      if (/^项目\s*[:：]/.test(lines[j])) break;
      detail.push(lines[j].replace(/^[-•·◆*]\s*/, ""));
      j += 1;
    }
    cursor = Math.max(cursor, j);
    projects.push({
      title: titleLine || `项目 ${projects.length + 1}`,
      detail: detail.join("；")
    });
  }

  if (!projects.length) {
    const inline = lines.filter((line) => /(负责|开发|设计|重构|上线)/.test(line) && line.length > 12);
    if (inline.length) {
      projects.push({
        title: "项目经历（待模型结构化）",
        detail: inline.slice(0, 6).join("；")
      });
    }
  }
  return projects.slice(0, 6);
}

function extractSkills(lines) {
  const skills = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^(专业技能|技能特长|技能|skills)/i.test(lines[i])) continue;
    const sameLine = lines[i].replace(/^(专业技能|技能特长|技能|skills)\s*[:：]?\s*/i, "").trim();
    if (sameLine) {
      sameLine
        .split(/[、，,;；/|]/)
        .map((item) => item.trim())
        .filter(Boolean)
        .forEach((item) => skills.push(item));
    }
    let j = i + 1;
    while (j < lines.length && !isSectionHeading(lines[j]) && skills.length < 40) {
      lines[j]
        .split(/[、，,;；/|]/)
        .map((item) => item.trim())
        .filter(Boolean)
        .forEach((item) => skills.push(item.replace(/^[-•·◆*]\s*/, "")));
      j += 1;
    }
  }
  return [...new Set(skills)].slice(0, 24);
}

function extractProfileFacts(lines) {
  const joined = lines.join("\n");
  const genderMatch = joined.match(/(?:性别|gender)\s*[:：]?\s*(男|女)/i);
  const yearsMatch = joined.match(/(\d{1,2})\s*年(?:经验|以上|工作)/);
  const email = joined.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  const phone = joined.match(/(?:\+?86[-\s]?)?1[3-9]\d{9}/);
  return {
    gender: genderMatch ? genderMatch[1] : "未知",
    years: yearsMatch ? yearsMatch[1] : "",
    email: email ? email[0] : "",
    phone: phone ? phone[0] : ""
  };
}

export function analyzeResumeLocal(raw = "") {
  const lines = cleanLines(raw);
  const facts = extractProfileFacts(lines);
  const projects = extractProjects(lines);
  const skills = extractSkills(lines);
  const summary = lines.slice(0, 3).join("；").slice(0, 300);
  return {
    source: "local",
    name: extractName(lines),
    gender: facts.gender,
    years: facts.years,
    email: facts.email,
    phone: facts.phone,
    projects,
    skills,
    summary,
    rawLength: raw.trim().length
  };
}

export function profileForPrompt(analysis) {
  if (!analysis) return "";
  const projects = (analysis.projects || [])
    .map((project, index) => {
      const tech = project.tech ? `（技术：${project.tech}）` : "";
      return `${index + 1}. ${project.title || "未命名项目"}${tech}：${project.detail || ""}`;
    })
    .join("\n");
  return [
    `姓名：${analysis.name || "未识别"}`,
    `性别：${analysis.gender || "未知"}`,
    analysis.years ? `工作年限：${analysis.years} 年` : "",
    `技能：${(analysis.skills || []).join("、") || "未提取"}`,
    projects ? `项目经历：\n${projects}` : "",
    analysis.summary ? `简历概览：${analysis.summary}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}
