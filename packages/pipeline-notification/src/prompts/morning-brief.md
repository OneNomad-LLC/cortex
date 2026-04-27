*Morning brief — {{date}}*

{{#if meetings}}
*Today's meetings ({{meeting_count}})*
{{meeting_list}}
{{else}}
_No meetings on the calendar today._
{{/if}}

{{#if priorities}}
*Pulled to the top*
{{priority_list}}
{{else}}
_No action items bubbling up. Either you're caught up, or run `cortex sync` to refresh._
{{/if}}

{{#if overnight}}
*Overnight*
{{overnight_list}}
{{/if}}

→ Open <{{dashboard_url}}|the Today view> to drill in.
