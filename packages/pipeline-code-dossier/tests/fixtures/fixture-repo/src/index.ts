// Widgetron public entry point.
//
// Converts a widget string into a wodget object. No I/O — caller is
// responsible for getting the input string in.

export interface Widget {
  readonly id: string;
  readonly name: string;
}

export interface Wodget {
  readonly id: string;
  readonly label: string;
  readonly dialect: "v2";
}

export function parse(input: string): Widget {
  const trimmed = input.trim();
  const [id, ...nameParts] = trimmed.split(":");
  return { id: id ?? "", name: nameParts.join(":") };
}

export function convert(w: Widget): Wodget {
  return { id: w.id, label: w.name, dialect: "v2" };
}

export function convertWidgetString(input: string): Wodget {
  return convert(parse(input));
}
