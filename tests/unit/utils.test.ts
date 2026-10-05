import { describe, it, expect } from "vitest";
import { escapeLike, likeContains, escapeHtml, jsonResult } from "../../src/utils.js";

describe("jsonResult", () => {
  const sample = { a: 1, nested: { b: [1, 2, { c: null }] }, list: [{ id: 1 }, { id: 2 }] };

  it("returns a single text content block", () => {
    const result = jsonResult(sample);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
  });

  it("is compact: no newlines or indentation", () => {
    const text = jsonResult(sample).content[0].text;
    expect(text).not.toMatch(/\n/);
    expect(text).toBe(JSON.stringify(sample));
  });

  it("round-trips the data exactly, nulls included", () => {
    const text = jsonResult(sample).content[0].text;
    expect(JSON.parse(text)).toEqual(sample);
  });

  it("is meaningfully smaller than the old indented form on a list of records", () => {
    const records = Array.from({ length: 50 }, (_, i) => ({ orderId: i, price: 1000 + i, state: "open", note: null }));
    const compact = jsonResult({ orders: records }).content[0].text.length;
    const indented = JSON.stringify({ orders: records }, null, 2).length;
    expect(compact).toBeLessThan(indented * 0.8);
  });
});

describe("escapeLike", () => {
  it("escapes % wildcard", () => {
    expect(escapeLike("100%")).toBe("100\\%");
  });

  it("escapes _ wildcard", () => {
    expect(escapeLike("foo_bar")).toBe("foo\\_bar");
  });

  it("escapes backslash", () => {
    expect(escapeLike("a\\b")).toBe("a\\\\b");
  });

  it("passes through normal text unchanged", () => {
    expect(escapeLike("hello world")).toBe("hello world");
  });

  it("escapes multiple special chars in sequence", () => {
    expect(escapeLike("50%_off\\")).toBe("50\\%\\_off\\\\");
  });

  it("handles empty string", () => {
    expect(escapeLike("")).toBe("");
  });
});

describe("likeContains", () => {
  it("wraps input with % for LIKE pattern", () => {
    expect(likeContains("foo")).toBe("%foo%");
  });

  it("escapes special chars before wrapping", () => {
    expect(likeContains("100%")).toBe("%100\\%%");
  });

  it("escapes underscore before wrapping", () => {
    expect(likeContains("_test")).toBe("%\\_test%");
  });
});

describe("escapeHtml", () => {
  it("escapes angle brackets", () => {
    expect(escapeHtml("<script>alert(1)</script>")).toBe(
      "&lt;script&gt;alert(1)&lt;/script&gt;"
    );
  });

  it("escapes ampersand", () => {
    expect(escapeHtml("a & b")).toBe("a &amp; b");
  });

  it("escapes double quotes", () => {
    expect(escapeHtml('"hello"')).toBe("&quot;hello&quot;");
  });

  it("escapes single quotes", () => {
    expect(escapeHtml("it's")).toBe("it&#39;s");
  });

  it("escapes all entities together", () => {
    expect(escapeHtml(`<a href="x" title='y'>&`)).toBe(
      "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;"
    );
  });

  it("passes through safe text unchanged", () => {
    expect(escapeHtml("hello world 123")).toBe("hello world 123");
  });

  it("handles empty string", () => {
    expect(escapeHtml("")).toBe("");
  });
});
