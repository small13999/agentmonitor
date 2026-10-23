// Checks that a running Agent Monitor serves a working app: the board renders, with no failed
// request, page error, or console error on the way. `/` answering 200 proves nothing: Vite
// serves the HTML even when the scripts behind it fail to build.
//
//   node scripts/smoke-live.ts [url]    (default http://127.0.0.1:5173/)
import { chromium } from "playwright";

const url = process.argv[2] ?? "http://127.0.0.1:5173/";
const problems: string[] = [];
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  page.on("pageerror", (error) => problems.push(`page error: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(`console error: ${message.text()}`);
  });
  page.on("response", (response) => {
    if (response.status() >= 400) problems.push(`${response.status()} ${response.url()}`);
  });
  await page.goto(url);
  await page.getByRole("region", { name: "Board" }).waitFor({ timeout: 15_000 }).catch((cause: unknown) => {
    problems.push(`the board did not render: ${String(cause).split("\n")[0]}`);
  });
} finally {
  await browser.close();
}
if (problems.length > 0) {
  console.error(`${url} is broken:\n${problems.join("\n")}`);
  process.exit(1);
}
console.log(`${url} renders the board`);
