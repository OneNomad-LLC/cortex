*End of day — {{date}}*

Today you touched *{{touched_count}}* action item{{plural_touched}}. *{{open_count}}* still open, *{{resolved_count}}* resolved.

{{#if open_count}}
*Still on the list*
{{open_list}}

Before you log off:
- Knock anything out? <{{dashboard_url}}|mark done in Today>
- Snooze something to tomorrow? Edit `due` in the source.
- New commitment from a meeting? Capture it now while it's fresh.
{{else}}
Clean slate. Either it was a quiet day or you're a machine. Log off, recharge.
{{/if}}
