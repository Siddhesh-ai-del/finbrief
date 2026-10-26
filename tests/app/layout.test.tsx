import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import RootLayout from "../../src/app/layout";

describe("root layout", () => {
  it("renders the document with an English language tag", () => {
    const html = renderToStaticMarkup(
      <RootLayout>
        <div data-testid="child">child content</div>
      </RootLayout>,
    );
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('data-testid="child"');
    expect(html).toContain("child content");
  });
});
