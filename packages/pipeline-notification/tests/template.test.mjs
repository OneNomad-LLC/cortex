import test from "node:test";
import assert from "node:assert/strict";

import { renderTemplate, render } from "../dist/template.js";

test("renderTemplate: variable interpolation", () => {
  const out = renderTemplate("Hello {{name}}, today is {{date}}.", {
    name: "Matt",
    date: "Monday",
  });
  assert.equal(out, "Hello Matt, today is Monday.");
});

test("renderTemplate: missing var renders as empty string", () => {
  const out = renderTemplate("Hi {{nope}}!", {});
  assert.equal(out, "Hi !");
});

test("renderTemplate: if block with truthy var renders inner", () => {
  const out = renderTemplate("{{#if x}}YES{{/if}}", { x: "value" });
  assert.equal(out, "YES");
});

test("renderTemplate: if block with falsy/missing var renders nothing", () => {
  assert.equal(renderTemplate("{{#if x}}YES{{/if}}", {}), "");
  assert.equal(renderTemplate("{{#if x}}YES{{/if}}", { x: "" }), "");
  assert.equal(renderTemplate("{{#if x}}YES{{/if}}", { x: 0 }), "");
  assert.equal(renderTemplate("{{#if x}}YES{{/if}}", { x: [] }), "");
  assert.equal(renderTemplate("{{#if x}}YES{{/if}}", { x: false }), "");
});

test("renderTemplate: if/else picks correct branch", () => {
  const tpl = "{{#if x}}IF{{else}}ELSE{{/if}}";
  assert.equal(renderTemplate(tpl, { x: true }), "IF");
  assert.equal(renderTemplate(tpl, { x: false }), "ELSE");
  assert.equal(renderTemplate(tpl, {}), "ELSE");
});

test("renderTemplate: variables inside if branches still interpolate", () => {
  const tpl = "{{#if name}}Hello {{name}}{{else}}Hello stranger{{/if}}";
  assert.equal(renderTemplate(tpl, { name: "Matt" }), "Hello Matt");
  assert.equal(renderTemplate(tpl, {}), "Hello stranger");
});

test("renderTemplate: array vars stringify via String()", () => {
  // Templates expect already-formatted strings — passing an array is
  // user error but should render readably, not 'undefined' or '[object Object]'.
  const out = renderTemplate("{{x}}", { x: ["a", "b"] });
  assert.equal(out, "a,b");
});

test("render: morning-brief loads + interpolates without error", () => {
  const out = render("morning-brief", {
    date: "2026-04-27",
    meetings: true,
    meeting_count: 2,
    meeting_list: "- 9am Standup\n- 2pm Client review",
    priorities: true,
    priority_list: "- Send slides\n- Review PR",
    overnight: false,
    dashboard_url: "http://localhost:3030/",
  });
  assert.match(out, /Morning brief/);
  assert.match(out, /2026-04-27/);
  assert.match(out, /9am Standup/);
  assert.match(out, /Send slides/);
  // overnight=false → its block should not render
  assert.doesNotMatch(out, /Overnight/);
});

test("render: pre-meeting-brief renders", () => {
  const out = render("pre-meeting-brief", {
    event_title: "Client kickoff",
    minutes_until: 30,
    start_time: "2:30 PM",
    attendee_summary: "person-a, billing-team",
    prior_meetings: false,
    open_commitments: true,
    commitments_list: "- send wireframes",
    suggested_questions: false,
    event_url: "https://meet.google.com/x",
    dashboard_url: "http://localhost:3030/",
  });
  assert.match(out, /Client kickoff/);
  assert.match(out, /send wireframes/);
});

test("render: eod-capture branches on open_count", () => {
  const withOpen = render("eod-capture", {
    date: "2026-04-27",
    touched_count: 5,
    plural_touched: "s",
    open_count: 2,
    resolved_count: 3,
    open_list: "- A\n- B",
    dashboard_url: "http://localhost:3030/",
  });
  assert.match(withOpen, /Still on the list/);

  const empty = render("eod-capture", {
    date: "2026-04-27",
    touched_count: 0,
    plural_touched: "s",
    open_count: 0,
    resolved_count: 0,
    open_list: "",
    dashboard_url: "http://localhost:3030/",
  });
  assert.match(empty, /Clean slate/);
  assert.doesNotMatch(empty, /Still on the list/);
});
