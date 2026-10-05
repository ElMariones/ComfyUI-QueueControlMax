# ComfyUI-QueueControlMax

One queue manager for ComfyUI, docked on the right side of the window. See what every job is (model, LoRAs, prompt, settings), put jobs in the order you want, never lose the queue to a restart or crash, and keep a permanent, searchable history of everything you generated, with one click back to the exact workflow that made each image.

No extra Python dependencies. Everything stays on your machine.

## Features

**Queue**
- **First in, first out.** New jobs always go to the end. No priority levels.
- **Reorder** with ⤒ ↑ ↓ ⤓ on each job, or drag a job onto another one. Shift+Run (send to front) still works.
- **Pause / Resume.** The running job finishes and nothing new starts until you resume. Buttons are in the top bar and in the panel.
- **Every job shows** its workflow name, model, LoRAs with strengths, positive and negative prompt, size, steps / CFG / sampler / seed, and Quality preset if one is used.
- **Open workflow** loads the exact workflow of any job (waiting, running, parked or finished) in a new tab: same prompt, LoRAs, strengths and seed. Change something and run it.
- **Copy prompt**, **Stop** the running job (with a live progress bar), **remove** waiting jobs, **Clear** the queue.
- **Park** a job to take it out of the queue without losing it. **Run** puts it back at the end, **Run next** at the front.
- **Filter** the queue by prompt text, model, LoRA or workflow name. Click a workflow chip to filter by it.

**Never lose the queue**
- **Autosave**: the waiting and running jobs are snapshotted every 2 seconds.
- **Auto-restore**: on the next start the queue comes back in the same order. Jobs that can no longer be queued (missing model or node) go to *Parked* with the reason.
- **Auto-resume**: by default the restored queue stays paused after a normal restart and resumes by itself after a crash, if your launcher sets `QCM_RESTARTED_AFTER_CRASH=1` when it restarts ComfyUI. Settings ⚙ can make it always or never resume.
- **Named saves**: *Save* the queue under a name and load it later (*Saves ▾*). Loading adds the jobs to the end.
- **Export / Import** the queue as a `.json` file.

**Persistent history**
- Every finished, failed or stopped job is stored permanently and survives restarts. It shows thumbnails, status, time taken, model, LoRAs and prompt.
- **Click an image** to view it full screen. Use ← → to browse, then *Open workflow*, *Copy prompt*, *Folder* (show in Explorer / Finder) or *Full size*.
- **Run again**, **star** ★ (starred entries survive *Clear history*), **delete** entries (the image files are never deleted).
- **Search** by prompt, model, LoRA or workflow. Filter by done or failed, or starred only. Switch between **list** and **image grid** views.
- **Import past images**: Settings ⚙ → *Import past images* scans your output folder and adds images made before you installed this. ComfyUI stores the workflow inside each PNG, so *Open workflow* works for them too. Images from one batch are grouped together.

## Install

```
cd ComfyUI/custom_nodes
git clone https://github.com/ElMariones/ComfyUI-QueueControlMax.git
```

Restart ComfyUI. Open the panel with the **Queue** button in the top bar, or **Alt+Q**.

### Coming from ComfyUI-QueueControl

Both extensions take over the same queue internals, so they can't run together. On the first start, QueueControlMax imports QueueControl's auto-backup (your waiting queue) and its saved queue, which shows up as *Imported from QueueControl* under *Saves ▾*. It then disables QueueControl by renaming its folder to `….disabled`. Rename the folder back to undo. Set the environment variable `QCM_NO_MIGRATE=1` to skip this.

## Where data is stored

Everything is in `ComfyUI/user/queue_control_max/`:

| File | What |
|---|---|
| `qcm.db` | SQLite: history, parked jobs, settings. Prompts and workflows are stored compressed. |
| `autosave.json` | The live queue snapshot used for auto-restore |
| `saves/*.json` | Named queue saves |
| `thumbs/` | Thumbnail cache (safe to delete) |

These files contain your full prompts and workflows unencrypted. Keep that in mind on a shared machine.

## Auto-resume after a crash (launcher example)

Windows PowerShell loop that restarts ComfyUI after a crash and tells QueueControlMax to resume. After a fatal CUDA error, such as "illegal memory access" followed by `Fatal Python error: Aborted`, Windows can keep the dying process alive for minutes. So the loop also restarts ComfyUI when its web server stops answering, not only when the process exits:

```powershell
$args = '-s','ComfyUI\main.py','--windows-standalone-build'
while ($true) {
    $p = Start-Process .\python_embeded\python.exe -ArgumentList $args -NoNewWindow -PassThru
    $null = $p.Handle; $up = $false; $down = $null; $killed = $false
    while (-not $p.WaitForExit(5000)) {                  # health check every 5 s
        try { $null = Invoke-WebRequest http://127.0.0.1:8188/system_stats -UseBasicParsing -TimeoutSec 5; $up = $true; $down = $null }
        catch { if ($up) { if (-not $down) { $down = Get-Date } elseif (((Get-Date) - $down).TotalSeconds -ge 45) {
            Stop-Process -Id $p.Id -Force; $killed = $true; break } } }   # crashed or hung
    }
    if (-not $killed -and $p.ExitCode -eq 0) { break }   # normal exit
    $env:QCM_RESTARTED_AFTER_CRASH = '1'                 # resume the restored queue
    Start-Sleep 5
}
```

## How it works

ComfyUI's queue is a heap ordered by each job's number, and new jobs get the next, largest number. QueueControlMax keeps that behaviour:
- **Reordering** only swaps numbers between waiting jobs, so a new job still lands last.
- **Pause** wraps `PromptQueue.get`.
- **History** wraps `PromptQueue.task_done` to record each finished job.

Nothing else in ComfyUI is replaced. The `/prompt` API and the native queue keep working.

## Credits

Inspired by [ComfyUI-QueueControl](https://github.com/seeker-ktf/ComfyUI-QueueControl) by seeker-ktf (pause, saved and persistent queue) and [comfyui_queue_manager](https://github.com/QuietNoise/comfyui_queue_manager) by QuietNoise (archive, export / import, workflow filter, gallery). QueueControlMax is a new implementation and contains no code from either project. See [NOTICE](NOTICE).

## License

Apache 2.0
