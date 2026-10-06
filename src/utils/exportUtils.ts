import { parseMarkdown } from "../components/Preview/markdownParser";
import type { ExportStyles } from "./exportAssets";
import { buildDocx } from "./docx";

/**
 * Downloads a file to user's computer
 */
function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Exports markdown text directly as a .md file
 */
export function exportAsMarkdown(filename: string, content: string) {
  const finalName = filename.endsWith(".md") ? filename : `${filename}.md`;
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  downloadBlob(blob, finalName);
}

/**
 * Exports the document as a Word file, generated in the browser from the
 * Markdown token stream.
 */
export function exportAsDocx(filename: string, markdownContent: string) {
  const finalName = filename.endsWith(".docx") ? filename : `${filename}.docx`;
  const bytes = buildDocx(markdownContent);
  const blob = new Blob([bytes as BlobPart], {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
  downloadBlob(blob, finalName);
}

/**
 * Builds the self-contained HTML document. Styles are passed in so this
 * stays a pure function that unit tests can check without Vite asset
 * imports.
 */
export function buildHtmlDocument(
  filename: string,
  markdownContent: string,
  styles: ExportStyles,
): string {
  const renderedContent = parseMarkdown(markdownContent);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(filename)}</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      line-height: 1.6;
      max-width: 860px;
      margin: 0 auto;
      padding: 40px 20px;
      color: #24292f;
      background-color: #ffffff;
    }
    h1, h2, h3, h4 { color: #1f2328; margin-top: 24px; margin-bottom: 16px; font-weight: 600; line-height: 1.25; }
    h1 { font-size: 2em; border-bottom: 1px solid #d0d7de; padding-bottom: 0.3em; }
    h2 { font-size: 1.5em; border-bottom: 1px solid #d0d7de; padding-bottom: 0.3em; }
    table { border-collapse: collapse; width: 100%; margin: 16px 0; }
    th, td { border: 1px solid #d0d7de; padding: 8px 12px; text-align: left; }
    th { background-color: #f6f8fa; }
    tr:nth-child(even) { background-color: #fbfcfd; }
    blockquote { border-left: 4px solid #0284c7; padding: 4px 16px; margin: 16px 0; color: #57606a; background: #f8fafc; }
    pre { background: #0f172a; color: #f8fafc; padding: 16px; border-radius: 8px; overflow-x: auto; }
    code { font-family: monospace; font-size: 0.9em; }
    :not(pre) > code { background: #f1f5f9; color: #db2777; padding: 2px 6px; border-radius: 4px; }
    img { max-width: 100%; height: auto; border-radius: 6px; }
  </style>
  <style>
${styles.highlightCss}
  </style>
  <style>
${styles.katexCss}
  </style>
</head>
<body>
  ${renderedContent}
</body>
</html>`;
}

/**
 * Exports document as a self-contained HTML file. Math and code styles,
 * including KaTeX fonts, are inlined as data so the file works offline
 * and without any external requests.
 */
export async function exportAsHtml(filename: string, markdownContent: string) {
  const finalName = filename.replace(/\.md$/, "") + ".html";
  const { exportStyles } = await import("./exportAssets");
  const htmlDocument = buildHtmlDocument(
    filename,
    markdownContent,
    exportStyles,
  );

  const blob = new Blob([htmlDocument], { type: "text/html;charset=utf-8" });
  downloadBlob(blob, finalName);
}

export interface StaticSitePage {
  name: string;
  content: string;
}

/**
 * Builds a single-file, browsable static site from a folder's Markdown
 * pages: a sidebar index, hash navigation, and prev and next links.
 * Publishing means hosting this one file anywhere.
 */
export function buildStaticSiteHtml(
  title: string,
  pages: StaticSitePage[],
  styles: ExportStyles,
): string {
  const nav = pages
    .map(
      (page, index) =>
        `<a href="#page-${index}" class="nav-link" data-index="${index}">${escapeHtml(
          page.name,
        )}</a>`,
    )
    .join("\n          ");

  const sections = pages
    .map(
      (page, index) =>
        `<section class="page" id="page-${index}" data-index="${index}">\n${parseMarkdown(
          page.content,
        )}\n</section>`,
    )
    .join("\n      ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; margin: 0; color: #24292f; background: #ffffff; display: flex; min-height: 100vh; }
    nav { width: 260px; shrink: 0; padding: 24px 16px; background: #f6f8fa; border-right: 1px solid #d0d7de; }
    nav h1 { font-size: 14px; margin: 0 0 12px; color: #1f2328; }
    .nav-link { display: block; padding: 6px 10px; margin: 2px 0; border-radius: 6px; color: #0969da; text-decoration: none; font-size: 13px; }
    .nav-link:hover { background: #ddf4ff; }
    .nav-link.active { background: #ddf4ff; font-weight: 600; }
    main { flex: 1; padding: 40px 48px; max-width: 860px; }
    .page { display: none; }
    .page.active { display: block; }
    .pager { margin-top: 32px; display: flex; justify-content: space-between; }
    .pager a { color: #0969da; text-decoration: none; font-size: 13px; }
    h1, h2 { border-bottom: 1px solid #d0d7de; padding-bottom: 0.3em; }
    table { border-collapse: collapse; width: 100%; margin: 16px 0; }
    th, td { border: 1px solid #d0d7de; padding: 8px 12px; text-align: left; }
    th { background: #f6f8fa; }
    pre { background: #0f172a; color: #f8fafc; padding: 16px; border-radius: 8px; overflow-x: auto; }
    code { font-family: monospace; font-size: 0.9em; }
    :not(pre) > code { background: #f1f5f9; padding: 2px 6px; border-radius: 4px; }
    img { max-width: 100%; height: auto; }
  </style>
  <style>
${styles.highlightCss}
  </style>
  <style>
${styles.katexCss}
  </style>
</head>
<body>
  <nav>
    <h1>${escapeHtml(title)}</h1>
          ${nav}
  </nav>
  <main>
      ${sections}
    <div class="pager">
      <a href="#" id="prev-link">Previous</a>
      <a href="#" id="next-link">Next</a>
    </div>
  </main>
  <script>
    (function () {
      var pages = document.querySelectorAll(".page");
      var links = document.querySelectorAll(".nav-link");
      function show(index) {
        index = Math.max(0, Math.min(index, pages.length - 1));
        pages.forEach(function (p) {
          p.classList.toggle("active", Number(p.dataset.index) === index);
        });
        links.forEach(function (l) {
          l.classList.toggle("active", Number(l.dataset.index) === index);
        });
        document.getElementById("prev-link").style.visibility = index > 0 ? "visible" : "hidden";
        document.getElementById("next-link").style.visibility = index < pages.length - 1 ? "visible" : "hidden";
        history.replaceState(null, "", "#page-" + index);
      }
      document.getElementById("prev-link").addEventListener("click", function (e) { e.preventDefault(); show(current() - 1); });
      document.getElementById("next-link").addEventListener("click", function (e) { e.preventDefault(); show(current() + 1); });
      links.forEach(function (l) {
        l.addEventListener("click", function () { show(Number(l.dataset.index)); });
      });
      function current() {
        var m = /#page-([0-9]+)/.exec(location.hash);
        return m ? Number(m[1]) : 0;
      }
      window.addEventListener("hashchange", function () { show(current()); });
      show(current());
    })();
  </script>
</body>
</html>`;
}

/**
 * Exports a folder of Markdown pages as a single-file static site with
 * math and code styles inlined, so it works offline with no requests.
 */
export async function exportAsStaticSite(
  title: string,
  pages: StaticSitePage[],
) {
  const { exportStyles } = await import("./exportAssets");
  const html = buildStaticSiteHtml(title, pages, exportStyles);
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  downloadBlob(blob, `${slugify(title)}-site.html`);
}

/**
 * Triggers browser print dialog for printing or saving to PDF
 */
export function exportAsPdf() {
  window.print();
}

function slugify(str: string): string {
  const slug = str.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  let start = 0;
  let end = slug.length;
  while (start < end && slug[start] === "-") start += 1;
  while (end > start && slug[end - 1] === "-") end -= 1;
  return start === end ? "export" : slug.slice(start, end);
}

function escapeHtml(str: string): string {
  return str.replace(/[&<>"']/g, (m) => {
    switch (m) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return m;
    }
  });
}
