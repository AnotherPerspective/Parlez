; Parlez! — installatore per Windows (Inno Setup 6).
;
; Costruito da costruisci.mjs, che prepara la cartella build\stage:
;   stage\node\node.exe, stage\node\LICENSE   Node.js portatile (MIT), dallo zip ufficiale
;   stage\app\                                il pacchetto parlez con le sue librerie
;   stage\parlez.cmd                          il comando «parlez» per il terminale
;   stage\AVVERTENZE-en.txt / -it.txt         le avvertenze, mostrate come pagina da accettare
;
; Installa solo per l'utente (niente permessi da amministratore) in
; %LOCALAPPDATA%\Programs\Parlez, poi lancia «parlez setup --accept»: è setup
; che scrive lo script di avvio, la sveglia e i pannelli nelle cartelle di
; After Effects e Premiere Pro dell'utente, esattamente come da terminale.
; Accettare le avvertenze nella pagina dell'installatore vale come «accetto».
;
; Il programma installato non si collega a internet. L'installatore nemmeno.

#ifndef AppVersion
  #error Passa la versione: ISCC /DAppVersion=0.2.0 parlez.iss
#endif
#ifndef StageDir
  #define StageDir "build\stage"
#endif
#ifndef OutputDir
  #define OutputDir "build\out"
#endif

[Setup]
; Non cambiare mai AppId: è quello che fa riconoscere una versione nuova come aggiornamento.
AppId={{4D5EB0AE-2E1B-4FAF-BB87-2EFA4CA98C80}
AppName=Parlez!
AppVersion={#AppVersion}
AppVerName=Parlez! {#AppVersion}
AppPublisher=Another Perspective Pictures SRL
AppPublisherURL=https://www.anotherperspectivepictures.com/Parlez/
AppSupportURL=https://github.com/AnotherPerspective/Parlez/issues
AppUpdatesURL=https://github.com/AnotherPerspective/Parlez/releases
AppCopyright=MIT — Copyright (c) 2026 kumo.productions, Inc.; Copyright (c) 2026 Another Perspective Pictures SRL
VersionInfoDescription=Parlez! per Adobe After Effects e Adobe Premiere Pro
DefaultDirName={autopf}\Parlez
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir={#OutputDir}
OutputBaseFilename=Parlez-{#AppVersion}-setup
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ChangesEnvironment=yes
UninstallDisplayName=Parlez! {#AppVersion}
UninstallDisplayIcon={app}\node\node.exe
SetupLogging=yes
ShowLanguageDialog=auto

[Languages]
Name: "it"; MessagesFile: "compiler:Languages\Italian.isl"; LicenseFile: "{#StageDir}\AVVERTENZE-it.txt"
Name: "en"; MessagesFile: "compiler:Default.isl"; LicenseFile: "{#StageDir}\AVVERTENZE-en.txt"

[CustomMessages]
it.CompCore=Programma Parlez! e Node.js portatile (obbligatorio)
en.CompCore=Parlez! program and portable Node.js (required)
it.CompAfter=Adobe® After Effects®: script di avvio, sveglia e pannello Parlez!
en.CompAfter=Adobe® After Effects®: startup script, sveglia and Parlez! panel
it.CompPremiere=Adobe® Premiere Pro®: pannello Parlez!
en.CompPremiere=Adobe® Premiere Pro®: Parlez! panel
it.TypeBoth=After Effects e Premiere Pro
en.TypeBoth=After Effects and Premiere Pro
it.TypeAfter=Solo After Effects
en.TypeAfter=After Effects only
it.TypePremiere=Solo Premiere Pro
en.TypePremiere=Premiere Pro only
it.TypeCustom=Scelta personalizzata
en.TypeCustom=Custom
it.TaskPath=Aggiungi il comando «parlez» al terminale (per parlez doctor)
en.TaskPath=Add the "parlez" command to the terminal (for parlez doctor)
it.TaskCepDebug=Accendi la modalità debug di CEP (PlayerDebugMode): serve alla sveglia di After Effects e al pannello di Premiere Pro, che non sono firmati. Vale per tutte le estensioni CEP non firmate; si rimette com'era quando disinstalli Parlez!.
en.TaskCepDebug=Turn on CEP debug mode (PlayerDebugMode): the After Effects sveglia and the Premiere Pro panel need it because they are not signed. It applies to every unsigned CEP extension; it is put back as it was when you uninstall Parlez!.
it.RunSetup=Preparo After Effects e Premiere Pro (parlez setup)...
en.RunSetup=Setting up After Effects and Premiere Pro (parlez setup)...
it.RunClaudeCode=Collega Parlez! a Claude Code adesso
en.RunClaudeCode=Connect Parlez! to Claude Code now
it.OpenReport=Apri le istruzioni per collegare Claude (e il risultato dell'installazione)
en.OpenReport=Open the instructions to connect Claude (and the setup result)

[Types]
Name: "both"; Description: "{cm:TypeBoth}"
Name: "after"; Description: "{cm:TypeAfter}"
Name: "premiere"; Description: "{cm:TypePremiere}"
Name: "custom"; Description: "{cm:TypeCustom}"; Flags: iscustom

[Components]
Name: "core"; Description: "{cm:CompCore}"; Types: both after premiere custom; Flags: fixed
Name: "after"; Description: "{cm:CompAfter}"; Types: both after
Name: "premiere"; Description: "{cm:CompPremiere}"; Types: both premiere

[Tasks]
Name: "addpath"; Description: "{cm:TaskPath}"
Name: "cepdebug"; Description: "{cm:TaskCepDebug}"

[Files]
Source: "{#StageDir}\node\*"; DestDir: "{app}\node"; Flags: ignoreversion recursesubdirs; Components: core
Source: "{#StageDir}\app\*"; DestDir: "{app}\app"; Flags: ignoreversion recursesubdirs createallsubdirs; Components: core
Source: "{#StageDir}\parlez.cmd"; DestDir: "{app}"; Flags: ignoreversion; Components: core
Source: "{#StageDir}\AVVERTENZE-it.txt"; DestDir: "{app}"; Flags: ignoreversion; Components: core
Source: "{#StageDir}\AVVERTENZE-en.txt"; DestDir: "{app}"; Flags: ignoreversion; Components: core

[InstallDelete]
; Un aggiornamento non deve lasciare file di una versione vecchia del programma.
Type: filesandordirs; Name: "{app}\app"

[Run]
Filename: "{cmd}"; Parameters: "/c ""{code:SetupCommand} > ""{app}\installazione.txt"" 2>&1"""; StatusMsg: "{cm:RunSetup}"; Flags: runhidden waituntilterminated
Filename: "{cmd}"; Parameters: "/c ""{code:ClaudeCodeCommand}"""; Description: "{cm:RunClaudeCode}"; Flags: postinstall runhidden waituntilterminated; Check: ClaudeCodeFound
Filename: "{app}\installazione.txt"; Description: "{cm:OpenReport}"; Flags: postinstall shellexec skipifsilent

[UninstallRun]
; Toglie da After Effects e Premiere quello che setup aveva messo, in tutte le versioni.
Filename: "{app}\node\node.exe"; Parameters: """{app}\app\dist\index.js"" uninstall-agent"; Flags: runhidden waituntilterminated; RunOnceId: "UninstallAgent"
Filename: "{app}\node\node.exe"; Parameters: """{app}\app\dist\index.js"" uninstall-panel"; Flags: runhidden waituntilterminated; RunOnceId: "UninstallPanel"
Filename: "{app}\node\node.exe"; Parameters: """{app}\app\dist\index.js"" uninstall-sveglia"; Flags: runhidden waituntilterminated; RunOnceId: "UninstallSveglia"
Filename: "{app}\node\node.exe"; Parameters: """{app}\app\dist\index.js"" uninstall-premiere-panel"; Flags: runhidden waituntilterminated; RunOnceId: "UninstallPremierePanel"
; Toglie la voce «parlez» da Claude Code, se Claude Code c'è (altrimenti cmd non trova il comando e non succede niente).
Filename: "{cmd}"; Parameters: "/c claude mcp remove parlez --scope user"; Flags: runhidden waituntilterminated; RunOnceId: "ClaudeRemove"

[UninstallDelete]
Type: files; Name: "{app}\installazione.txt"

[Code]
const
  EnvKey = 'Environment';

function NodeExe(): String;
begin
  Result := ExpandConstant('{app}\node\node.exe');
end;

function IndexJs(): String;
begin
  Result := ExpandConstant('{app}\app\dist\index.js');
end;

{ La riga di parlez setup: lingua dell'installatore, accettazione già data
  nella pagina delle avvertenze, tutte le versioni di After Effects trovate,
  e solo le parti scelte. }
function SetupCommand(Param: String): String;
var
  Only: String;
begin
  Only := '';
  if WizardIsComponentSelected('after') and not WizardIsComponentSelected('premiere') then
    Only := ' --only after'
  else if WizardIsComponentSelected('premiere') and not WizardIsComponentSelected('after') then
    Only := ' --only premiere';
  Result := '"' + NodeExe() + '" "' + IndexJs() + '" setup --accept --all --lang ' +
    ActiveLanguage() + Only;
end;

function ClaudeCodeCommand(Param: String): String;
begin
  { Se una voce «parlez» c'è già (per esempio da npm), la sostituisce con questa installazione. }
  Result := 'claude mcp remove parlez --scope user >nul 2>&1 & claude mcp add --scope user parlez -e AE_MCP_PULL_ONLY=1 -- "' +
    NodeExe() + '" "' + IndexJs() + '"';
end;

{ Claude Code si trova cercando claude.exe / claude.cmd nel PATH dell'utente,
  senza lanciare niente. }
function ClaudeCodeFound(): Boolean;
var
  Paths, Dir: String;
  P: Integer;
begin
  Result := False;
  Paths := GetEnv('PATH') + ';';
  while (not Result) and (Length(Paths) > 0) do
  begin
    P := Pos(';', Paths);
    Dir := Trim(Copy(Paths, 1, P - 1));
    Delete(Paths, 1, P);
    if Dir <> '' then
      Result := FileExists(AddBackslash(Dir) + 'claude.exe') or FileExists(AddBackslash(Dir) + 'claude.cmd');
  end;
end;

{ --- Il comando «parlez» nel PATH dell'utente (solo HKCU) --- }

function PathHas(const Paths, Dir: String): Boolean;
begin
  Result := Pos(';' + Uppercase(Dir) + ';', ';' + Uppercase(Paths) + ';') > 0;
end;

procedure AddToUserPath(const Dir: String);
var
  Paths: String;
begin
  if not RegQueryStringValue(HKCU, EnvKey, 'Path', Paths) then Paths := '';
  if PathHas(Paths, Dir) then exit;
  if (Paths <> '') and (Copy(Paths, Length(Paths), 1) <> ';') then Paths := Paths + ';';
  RegWriteExpandStringValue(HKCU, EnvKey, 'Path', Paths + Dir);
end;

procedure RemoveFromUserPath(const Dir: String);
var
  Paths: String;
  P: Integer;
begin
  if not RegQueryStringValue(HKCU, EnvKey, 'Path', Paths) then exit;
  Paths := ';' + Paths + ';';
  P := Pos(';' + Uppercase(Dir) + ';', Uppercase(Paths));
  if P = 0 then exit;
  Delete(Paths, P, Length(Dir) + 1);
  { toglie i punto e virgola aggiunti sopra }
  Paths := Copy(Paths, 2, Length(Paths) - 2);
  RegWriteExpandStringValue(HKCU, EnvKey, 'Path', Paths);
end;

{ --- PlayerDebugMode di CEP: acceso solo se l'utente lo sceglie, e rimesso
  com'era alla disinstallazione. Per ogni CSXS.<n> che cambiamo ci segniamo
  il valore di prima sotto HKCU\Software\Parlez. CSXS.11 = After Effects e
  Premiere 2024, CSXS.12 = 2025 e 2026 (gli stessi che legge parlez setup). --- }

const
  OurKey = 'Software\Parlez';

procedure TurnOnCepDebug();
var
  Major: Integer;
  Key, Old: String;
begin
  for Major := 11 to 12 do
  begin
    Key := 'Software\Adobe\CSXS.' + IntToStr(Major);
    if not RegQueryStringValue(HKCU, Key, 'PlayerDebugMode', Old) then Old := '<assente>';
    if Old <> '1' then
    begin
      RegWriteStringValue(HKCU, OurKey, 'PrimaPlayerDebugMode.' + IntToStr(Major), Old);
      RegWriteStringValue(HKCU, Key, 'PlayerDebugMode', '1');
    end;
  end;
end;

procedure RestoreCepDebug();
var
  Major: Integer;
  Key, Old: String;
begin
  for Major := 11 to 12 do
  begin
    Key := 'Software\Adobe\CSXS.' + IntToStr(Major);
    if RegQueryStringValue(HKCU, OurKey, 'PrimaPlayerDebugMode.' + IntToStr(Major), Old) then
    begin
      if Old = '<assente>' then
        RegDeleteValue(HKCU, Key, 'PlayerDebugMode')
      else
        RegWriteStringValue(HKCU, Key, 'PlayerDebugMode', Old);
    end;
  end;
  RegDeleteKeyIncludingSubkeys(HKCU, OurKey);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  { ssInstall: prima dei file e prima di parlez setup, che legge PlayerDebugMode e il PATH. }
  if CurStep = ssInstall then
  begin
    if WizardIsTaskSelected('cepdebug') then TurnOnCepDebug();
    if WizardIsTaskSelected('addpath') then AddToUserPath(ExpandConstant('{app}'));
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usPostUninstall then
  begin
    RemoveFromUserPath(ExpandConstant('{app}'));
    RestoreCepDebug();
  end;
end;
