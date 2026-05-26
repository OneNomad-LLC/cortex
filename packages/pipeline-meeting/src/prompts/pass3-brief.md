Write a meeting brief in markdown optimized for a busy reader scanning quickly:
front-load what matters, use headings, keep sentences short.

Structure:

```
# {{TITLE}}

_{{DATE}} · {{PARTICIPANTS}}_

## TL;DR
(2-4 bullets. The decisions and action items. What changed.)

## Decisions
(Bullet list. Owner in bold if known. One line each.)

## Action items
(Checkbox list. Owner in bold. Due date if known. One line each.)

## Discussion
(3-6 bullets. Only topics that affect future decisions. Skip
small-talk, meta-meeting talk, and pleasantries.)

## Open threads
(Things that were raised but not resolved. Bullet list. Empty if none.)
```

Rules:
- Never say "we discussed". Say what was decided, asked, or committed.
- Don't repeat the same item in two sections.
- Every action item should be in Markdown checkbox form `- [ ] …`.
- Decisions go as `- **Owner:** decision statement.` If no owner, drop the bold prefix.
- No preamble before the title. No postscript after the last section.

INPUT (structured JSON from pass 2):

{{SYNTHESIZED_INPUT}}
