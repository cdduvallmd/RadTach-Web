// Quick Start Guide: the AutoHotkey v2 hotkey script, shown as text with a
// Copy button. Copy, not a download: hospital security tools block browser
// downloads. The script is a real file (src/content/RadiologyKeys.ahk),
// bundled as text — edit the .ahk directly. Keystrokes only; no PHI.
import { useState } from 'react';
import script from '../content/RadiologyKeys.ahk?raw';

export function HotkeyScript() {
  const [copied, setCopied] = useState<boolean | null>(null);

  const copy = () => {
    navigator.clipboard.writeText(script).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  };

  return (
    <section>
      <h2 className="text-2xl font-bold text-white mb-3">Hotkey Script (AutoHotkey v2)</h2>
      <p className="mb-2">
        Optional. Lets programmable mouse buttons or a remote (sending F13–F24, with Shift, Alt or Ctrl) drive
        PowerScribe 360 and Visage. Each key brings its program to the front, then sends the command. If the
        program isn't running, the key does nothing. RadTach does not need this script.
      </p>
      <ol className="list-decimal ml-6 space-y-1 mb-3 text-sm">
        <li>Make sure <strong>AutoHotkey v2</strong> is installed on the workstation.</li>
        <li>Click <strong>Copy Script</strong> below.</li>
        <li>Open <strong>Notepad</strong>, paste, and choose <strong>File → Save As</strong>.</li>
        <li>Set "Save as type" to <strong>All files</strong> and name it <strong>RadiologyKeys.ahk</strong>.</li>
        <li>Double-click the saved file to run it. A green <strong>H</strong> icon appears in the system tray.</li>
        <li>To start it at sign-in: press <strong>Win+R</strong>, type <strong>shell:startup</strong>, and put a shortcut to the file there.</li>
      </ol>
      <div className="flex items-center gap-3 mb-2">
        <button
          onClick={copy}
          className="bg-blue-600 hover:bg-blue-700 text-white font-semibold px-4 py-2 rounded"
        >
          Copy Script
        </button>
        {copied === true && <span className="text-sm text-green-400">Copied — paste it into Notepad.</span>}
        {copied === false && <span className="text-sm text-yellow-400">Copy was blocked. Click in the box, press Ctrl+A, then Ctrl+C.</span>}
      </div>
      <textarea
        readOnly
        value={script}
        spellCheck={false}
        className="w-full h-64 bg-gray-900 text-gray-200 font-mono text-xs p-3 rounded border border-gray-600 whitespace-pre"
        onFocus={e => e.currentTarget.select()}
      />
    </section>
  );
}
