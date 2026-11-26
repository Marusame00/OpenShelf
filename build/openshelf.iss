; build/openshelf.iss — Inno Setup script for the OpenShelf Windows installer.
;
; Build:  ISCC.exe build\openshelf.iss
; Needs the portable folder from build\build-win.js (dist\OpenShelf-portable).
; Installs per-user by default (no admin prompt); the user can switch to an
; all-users install from the privileges dialog.

#define AppName "OpenShelf"
#define AppVersion "1.2.0"
#define AppPublisher "Marusame00"
#define AppUrl "https://github.com/Marusame00/OpenShelf"
#define AppExe "OpenShelf.exe"

[Setup]
AppId={{8F3C1B42-5D7A-4E19-9C2B-6A1F0D3E7B54}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppUrl}
AppSupportURL={#AppUrl}/issues
AppUpdatesURL={#AppUrl}/releases
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
LicenseFile=..\LICENSE
OutputDir=..\dist
OutputBaseFilename=OpenShelf-{#AppVersion}-setup-win-x64
SetupIconFile=icon.ico
UninstallDisplayIcon={app}\{#AppExe}
UninstallDisplayName={#AppName} {#AppVersion}
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
CloseApplications=yes
AppMutex=OpenShelf.Launcher.SingleInstance
MinVersion=10.0

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"
Name: "startup"; Description: "Start OpenShelf when I sign in"; GroupDescription: "Startup:"; Flags: unchecked

[Files]
Source: "..\dist\OpenShelf-portable\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AppExe}"; Comment: "Open the OpenShelf web UI"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: desktopicon
Name: "{userstartup}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: startup

[Run]
Filename: "{app}\{#AppExe}"; Description: "{cm:LaunchProgram,{#AppName}}"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "{sys}\taskkill.exe"; Parameters: "/T /F /IM {#AppExe}"; Flags: runhidden skipifdoesntexist; RunOnceId: "StopLauncher"

[UninstallDelete]
Type: files; Name: "{app}\sortstore.json"
Type: files; Name: "{app}\openshelf.config.json"
Type: filesandordirs; Name: "{app}\thumbs"

[Code]
// Offer to keep the user's library list when uninstalling.
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usPostUninstall then
  begin
    // Nothing extra: [UninstallDelete] already removed the generated files.
  end;
end;
