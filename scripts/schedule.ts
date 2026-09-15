const intervalMinutes = Number(process.env.BCTS_SCHEDULE_MINUTES ?? 360);
if (
  !Number.isSafeInteger(intervalMinutes) ||
  intervalMinutes < 15 ||
  !Number.isSafeInteger(intervalMinutes * 60)
) {
  throw new Error(
    "BCTS_SCHEDULE_MINUTES must be a safe integer >= 15 with a safe interval.",
  );
}

const projectPath = process.cwd();
const plist = {
  Label: "local.bandcamp-tidal-sync",
  ProgramArguments: ["/usr/bin/env", "bun", "run", "scan:bandcamp"],
  WorkingDirectory: projectPath,
  StartInterval: intervalMinutes * 60,
  StandardOutPath: `${projectPath}/output/schedule.log`,
  StandardErrorPath: `${projectPath}/output/schedule.error.log`,
  RunAtLoad: false,
};

console.log(
  `Save as ~/Library/LaunchAgents/${plist.Label}.plist, then load it with launchctl.`,
);
const xml = (value: unknown): string => {
  if (typeof value === "boolean") return value ? "<true/>" : "<false/>";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value))
      throw new Error("Property-list numbers must be safe integers.");
    return `<integer>${value}</integer>`;
  }
  if (Array.isArray(value)) return `<array>${value.map(xml).join("")}</array>`;
  if (value && typeof value === "object")
    return `<dict>${Object.entries(value)
      .map(([key, child]) => `<key>${key}</key>${xml(child)}`)
      .join("")}</dict>`;
  const string = String(value);
  if (
    Array.from(string).some((character) => {
      const codeUnit = character.charCodeAt(0);
      return (
        codeUnit <= 0x08 ||
        (codeUnit >= 0x0b && codeUnit <= 0x0c) ||
        (codeUnit >= 0x0e && codeUnit <= 0x1f)
      );
    })
  )
    throw new Error("Property-list strings contain an XML-illegal character.");
  return `<string>${string
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")}</string>`;
};
console.log(
  `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">${xml(plist)}</plist>`,
);
