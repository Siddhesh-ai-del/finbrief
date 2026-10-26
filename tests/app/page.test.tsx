/** @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import Page from "../../src/app/page";

describe("app shell", () => {
  it("renders the product name as the page heading", () => {
    render(<Page />);
    expect(
      screen.getByRole("heading", { level: 1, name: /finbrief/i }),
    ).toBeTruthy();
  });

  it("states the pre-release status honestly on the page", () => {
    render(<Page />);
    expect(screen.getByText("Pre-release.")).toBeTruthy();
  });
});
