import fs from "node:fs";
import path from "node:path";

const bodyPath = path.join(process.cwd(), "src", "legacy", "body.html");
const legacyBodyHtml = fs.readFileSync(bodyPath, "utf8");

export default function Page() {
  return (
    <div
      // Avoid introducing a layout wrapper; the legacy DOM expects to be top-level.
      style={{ display: "contents" }}
      dangerouslySetInnerHTML={{ __html: legacyBodyHtml }}
    />
  );
}

