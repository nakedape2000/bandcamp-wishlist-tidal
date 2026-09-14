const intervalMinutes = Number(process.env.BCTS_SCHEDULE_MINUTES ?? 360);
if (!Number.isInteger(intervalMinutes) || intervalMinutes < 15) {
  throw new Error("BCTS_SCHEDULE_MINUTES must be an integer >= 15.");
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
console.log(JSON.stringify(plist, null, 2));
