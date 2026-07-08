const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { description } = require('../../package.json');

const version = '1.03';
const appName = 'HFScaIF';
const installerName = `HFScaIF-v${version}`;
const defaultInstallDir = 'C:\\Telenorma\\node-mettler-toledo';
const sourceDir = path.resolve('./release/node-mt-middleware-win32-x64');
const outputDir = path.resolve('./exes');

// Find InnoSetup compiler
function findISCC() {
  const candidates = [
    'C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe',
    'C:\\Program Files\\Inno Setup 6\\ISCC.exe',
    'C:\\Program Files (x86)\\Inno Setup 5\\ISCC.exe',
    'C:\\Program Files\\Inno Setup 5\\ISCC.exe',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// Generate InnoSetup script
function generateISS() {
  return `[Setup]
AppName=${appName}
AppVersion=${version}
DefaultDirName=${defaultInstallDir}
DefaultGroupName=${appName}
OutputDir=${outputDir}
OutputBaseFilename=${installerName}
Compression=lzma
SolidCompression=yes
DisableProgramGroupPage=yes
PrivilegesRequired=admin
UninstallDisplayName=${appName} v${version}

[Files]
Source: "${sourceDir}\\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{app}\\${appName}"; Filename: "{app}\\Node-mt-middleware.exe"

[Run]
Filename: "{app}\\Node-mt-middleware.exe"; Description: "Start ${appName}"; Flags: nowait postinstall skipifsilent
`;
}

(async function () {
  try {
    // Check source exists
    if (!fs.existsSync(sourceDir)) {
      console.error('ERROR: Release folder not found at:', sourceDir);
      console.error('Run electron-packager first.');
      process.exit(1);
    }

    // Create output dir
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const iscc = findISCC();
    if (!iscc) {
      console.error('InnoSetup not found!');
      console.error('Download and install from: https://jrsoftware.org/isdl.php');
      console.error('');
      console.error('After installing, run this script again.');
      process.exit(1);
    }

    // Write .iss file
    const issPath = path.resolve('./exes/installer.iss');
    fs.writeFileSync(issPath, generateISS(), 'utf8');
    console.log('InnoSetup script generated:', issPath);

    // Compile installer
    console.log('Compiling installer with:', iscc);
    execSync(`"${iscc}" "${issPath}"`, { stdio: 'inherit' });

    console.log('');
    console.log(`Installer created: exes/${installerName}.exe`);
    console.log(`Default install path: ${defaultInstallDir}`);
  } catch (e) {
    console.error('Build failed:', e.message);
    process.exit(1);
  }
})();
