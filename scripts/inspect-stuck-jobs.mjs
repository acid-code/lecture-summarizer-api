import fs from "node:fs";
import { createClient } from "@libsql/client";

for (const line of fs.readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([^#=\s]+)\s*=\s*(.*)$/);
  if (!m) continue;
  let v = m[2].trim();
  // Vercel pull wraps values in double quotes and escapes \" \\ \n
  if (v.startsWith('"') && v.endsWith('"')) {
    v = v.slice(1, -1).replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  } else if (v.startsWith("'") && v.endsWith("'")) v = v.slice(1, -1);
  process.env[m[1].trim()] ??= v;
}

const url = (process.env.DATABASE_URL || "").trim();
const tok = (process.env.DATABASE_AUTH_TOKEN || "").trim();
console.log(JSON.stringify({
  urlLen: url.length,
  tokLen: tok.length,
  urlLooksLibsql: url.startsWith("libsql://"),
  urlLooksHttp: /^https?:\/\//.test(url),
  urlFirstCode: [...url.slice(0, 8)].map((c) => c.charCodeAt(0)),
  envHasDatabaseUrlLine: /DATABASE_URL=/.test(fs.readFileSync(".env.local", "utf8")),
}));
if (!url.startsWith("libsql://") && !url.startsWith("http")) {
  console.error("DATABASE_URL from vercel env pull is not a usable libsql URL; aborting.");
  process.exit(2);
}
const db = createClient({ url, authToken: tok });

const stuck = await db.execute(`
  SELECT j.id, j.stage, j.error, j.updated_at, l.title, c.name AS course,
    json_extract(j.artifacts, '$.holdUntil') AS holdUntil,
    json_extract(j.artifacts, '$.run') AS run,
    json_extract(j.artifacts, '$.asrIncomplete') AS asrIncomplete,
    json_extract(j.artifacts, '$.pdf') AS pdf,
    json_extract(j.artifacts, '$.summary.title') AS summaryTitle,
    json_extract(j.artifacts, '$.progressDetail') AS progressDetail,
    json_extract(j.artifacts, '$.options.density') AS density,
    json_extract(j.artifacts, '$.figuresNote') AS figuresNote
  FROM jobs j
  JOIN lectures l ON l.id = j.lecture_id
  JOIN courses c ON c.id = l.course_id
  WHERE j.stage NOT IN ('done')
  ORDER BY j.updated_at DESC
  LIMIT 40
`);
console.log("=== non-done jobs ===");
console.log(JSON.stringify(stuck.rows, null, 2));

const done = await db.execute(`
  SELECT j.id, j.stage, j.updated_at, l.title,
    json_extract(j.artifacts, '$.figuresNote') AS figuresNote,
    json_array_length(json_extract(j.artifacts, '$.figures')) AS figN,
    json_extract(j.artifacts, '$.options.density') AS density,
    json_extract(j.artifacts, '$.asrIncomplete') AS asrIncomplete
  FROM jobs j
  JOIN lectures l ON l.id = j.lecture_id
  WHERE j.stage = 'done'
  ORDER BY j.updated_at DESC
  LIMIT 20
`);
console.log("=== recent done (figures) ===");
console.log(JSON.stringify(done.rows, null, 2));
