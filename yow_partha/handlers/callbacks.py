"""All inline-button taps land here.

`callback_data` schema (kept compact — Telegram caps at 64 bytes):
  home                       → re-render home table
  target:<tid>               → drill into per-target sub-screen
  start:<tid>                → start a target (confirmation may interpose)
  stop:<tid>                 → ask one-tap confirm, then fire
  restart:<tid>              → ask one-tap confirm, then fire
  run:<tid>                  → fire one-shot (backtest / compare)
  logs:<tid>                 → tail logs and reply
  delete:<kind>              → ask confirm
  shutdown:confirm1          → second confirmation
  shutdown:confirm2          → fire shutdown
  do:<action>:<tid_or_kind>  → confirmed action — fire it
  noop                       → ungated date in the picker (does nothing)
"""

from __future__ import annotations

import logging

from telegram import InlineKeyboardButton, InlineKeyboardMarkup, Update
from telegram.ext import ContextTypes

from .._auth import guard
from .._runners.bats import (
    fire_delete,
    fire_run,
    fire_shutdown,
    restart_target,
    start_target,
    stop_pid,
    stop_target,
)
from .._runners.targets import TARGETS
from .._ui import (
    home_button_only,
    render_confirm,
    render_delete_confirm,
    render_group,
    render_home,
    render_new_picker,
    render_placeholder,
    render_shutdown_confirm2,
    render_target,
    render_tools,
)

log = logging.getLogger(__name__)


def _build_replay_picker(ctx: ContextTypes.DEFAULT_TYPE, tid: str):
    """Build the replay date picker for `tid`.

    Splits dates into two groups:
      - locked   = dates with a replay process already running (shown 🟢🔒,
                   tap routes to a Stop/Back prompt, never toggles).
      - selectable = remaining unprocessed dates (raw exists, no parquet,
                   not reserved) — these are the ☐/☑ toggles.

    The stored selection is intersected with the selectable set in place, so
    a date that started running since the last render silently drops out of
    the selection. Returns (text, markup) or None when there is nothing to
    show at all.
    """
    from .picker import available_replay_dates
    from .._status import list_running
    from .._ui import render_train_picker

    inst = TARGETS[tid]["inst"]
    running_dates: set[str] = set()
    for p in list_running("replay"):
        if p["inst"] == inst:
            running_dates.update(p["dates"])

    selectable = [d for d in available_replay_dates(inst) if d not in running_dates]
    all_dates = sorted(set(selectable) | running_dates)
    if not all_dates:
        return None

    sel = ctx.user_data.setdefault("train_picker", {}).setdefault(tid, set())
    sel &= set(selectable)  # in-place: keep selection within selectable dates
    return render_train_picker(tid, all_dates, selected=sel, locked=running_dates)


@guard
async def on_callback(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    q = update.callback_query
    if not q:
        return
    await q.answer()  # remove the spinner on the user's tap

    data = q.data or ""
    parts = data.split(":")

    try:
        # Home
        if data == "home":
            text, markup = render_home()
            await q.edit_message_text(text, reply_markup=markup)
            return

        # No-op (greyed date in picker)
        if data == "noop":
            return

        head = parts[0]

        # Drill into per-target screen
        if head == "target":
            tid = parts[1]
            text, markup = render_target(tid)
            await q.edit_message_text(text, reply_markup=markup)
            return

        # Drill into a group submenu (Record / Replay / Train / Tools)
        if head == "group":
            kind = parts[1]
            if kind == "tools":
                text, markup = render_tools()
            else:
                text, markup = render_group(kind)
            await q.edit_message_text(text, reply_markup=markup)
            return

        # Placeholder pages (Backtest / Compare / SEA / Watch)
        if head == "placeholder":
            kind = parts[1]
            text, markup = render_placeholder(kind)
            await q.edit_message_text(text, reply_markup=markup)
            return

        # Tools actions
        if head == "tool":
            from .tools import handle_tool
            text = handle_tool(parts[1])
            await q.edit_message_text(text, reply_markup=home_button_only())
            return

        # "+ Start new replay/train" → 4-instrument picker
        if head == "new":
            kind = parts[1]
            text, markup = render_new_picker(kind)
            await q.edit_message_text(text, reply_markup=markup)
            return

        # Per-pid stop (from Replay/Train submenu running list)
        if head == "pidstop":
            try:
                pid = int(parts[1])
            except (ValueError, IndexError):
                await q.edit_message_text("❌ Invalid pid", reply_markup=home_button_only())
                return
            msg = stop_pid(pid)
            await q.edit_message_text(msg, reply_markup=home_button_only())
            return

        # Start — no confirm needed (creating something is benign), but train
        # and replay both need a multi-select date picker before firing.
        if head == "start":
            tid = parts[1]
            t = TARGETS.get(tid)
            if t and t["kind"] == "replay":
                # Replay: instrument → date picker with running dates locked.
                ctx.user_data.setdefault("train_picker", {})[tid] = set()
                res = _build_replay_picker(ctx, tid)
                if res is None:
                    await q.edit_message_text(
                        f"❌ No replay-able dates for {t['noun']} (all already replayed or reserved).",
                        reply_markup=home_button_only(),
                    )
                    return
                text, markup = res
                await q.edit_message_text(text, reply_markup=markup)
                return
            if t and t["kind"] == "train":
                from .picker import available_dates
                from .._ui import render_train_picker
                dates = available_dates(t["inst"])
                if not dates:
                    await q.edit_message_text(
                        f"❌ No trainable dates for {t['noun']}.",
                        reply_markup=home_button_only(),
                    )
                    return
                ctx.user_data.setdefault("train_picker", {})[tid] = set()
                text, markup = render_train_picker(tid, dates, selected=set())
                await q.edit_message_text(text, reply_markup=markup)
                return
            msg = start_target(tid)
            await q.edit_message_text(msg, reply_markup=home_button_only())
            return

        # Multi-select toggle — flip the date and re-render the picker.
        if head == "tog":
            tid = parts[1]
            date = parts[2]
            t = TARGETS[tid]
            pick_state = ctx.user_data.setdefault("train_picker", {}).setdefault(tid, set())
            if date in pick_state:
                pick_state.discard(date)
            else:
                pick_state.add(date)
            if t["kind"] == "replay":
                res = _build_replay_picker(ctx, tid)
                if res is None:
                    await q.edit_message_text("No replay-able dates.", reply_markup=home_button_only())
                    return
                text, markup = res
            else:
                from .picker import available_dates
                from .._ui import render_train_picker
                dates = available_dates(t["inst"])
                text, markup = render_train_picker(tid, dates, selected=pick_state)
            await q.edit_message_text(text, reply_markup=markup)
            return

        # Tap a 🟢🔒 running date in the replay picker → Stop / Back prompt.
        # The locked row never toggles a date; it only routes here.
        if head == "lock":
            tid = parts[1]
            date = parts[2]
            t = TARGETS[tid]
            text = f"🟢 {t['noun']} replay for {date} is running.\n\nStop it?"
            buttons = [[
                InlineKeyboardButton("⏹ Stop", callback_data=f"dostop:{tid}:{date}"),
                InlineKeyboardButton("↩ Back", callback_data=f"rpick:{tid}"),
            ]]
            await q.edit_message_text(text, reply_markup=InlineKeyboardMarkup(buttons))
            return

        # Back from the Stop prompt → re-render the replay picker as-is.
        if head == "rpick":
            tid = parts[1]
            res = _build_replay_picker(ctx, tid)
            if res is None:
                await q.edit_message_text("No replay-able dates.", reply_markup=home_button_only())
                return
            text, markup = res
            await q.edit_message_text(text, reply_markup=markup)
            return

        # Confirmed stop of one running replay date → kill just that pid,
        # then drop straight back into the (now-updated) picker.
        if head == "dostop":
            tid = parts[1]
            date = parts[2]
            from .._status import list_running
            inst = TARGETS[tid]["inst"]
            pid = None
            for p in list_running("replay"):
                if p["inst"] == inst and date in p["dates"]:
                    pid = p["pid"]
                    break
            if pid is None:
                head_msg = f"⚠️ No running replay found for {date} (already stopped?)."
            else:
                head_msg = stop_pid(pid)
            res = _build_replay_picker(ctx, tid)
            if res is None:
                await q.edit_message_text(head_msg, reply_markup=home_button_only())
                return
            text, markup = res
            await q.edit_message_text(f"{head_msg}\n\n{text}", reply_markup=markup)
            return

        # Confirm multi-select → fire on the picked set. Train uses a
        # single train-auto.bat with --include-dates flags; replay spawns
        # ONE process per date so each shows as an individual entry in
        # the Replay submenu.
        if head == "tconf":
            tid = parts[1]
            t = TARGETS[tid]
            pick_state = ctx.user_data.get("train_picker", {}).get(tid, set())
            picked_dates = sorted(pick_state)
            if not picked_dates:
                await q.edit_message_text(
                    "❌ No dates selected.",
                    reply_markup=home_button_only(),
                )
                return
            from .._runners.bats import _bat_path
            from .._runners.bats import ROOT as _root
            import subprocess
            if t["kind"] == "train":
                bat_path = _bat_path("train-auto.bat")
                title = f"Lubas: {t['noun']} (+{len(picked_dates)}d)"
                flags: list[str] = []
                for d in picked_dates:
                    flags += ["--include-dates", d]
                cmd_args = ["cmd", "/c", "start", title, "cmd", "/k",
                            str(bat_path), t["inst"], *flags]
                try:
                    subprocess.Popen(cmd_args, cwd=str(_root))
                    msg = (f"▶ Training {t['noun']} on {len(picked_dates)} date(s) "
                           f"({picked_dates[0]} … {picked_dates[-1]})")
                except OSError as exc:
                    msg = f"❌ Failed: {exc}"
            elif t["kind"] == "replay":
                bat_path = _bat_path("start-replay.bat")
                launched = 0
                fail: str | None = None
                for d in picked_dates:
                    title = f"Lubas: {t['noun']} {d}"
                    cmd_args = ["cmd", "/c", "start", title, "cmd", "/k",
                                str(bat_path), t["inst"], "--date", d]
                    try:
                        subprocess.Popen(cmd_args, cwd=str(_root))
                        launched += 1
                    except OSError as exc:
                        fail = str(exc)
                        break
                if fail:
                    msg = f"❌ Launched {launched}/{len(picked_dates)}, then failed: {fail}"
                else:
                    msg = (f"▶ Launched {launched} replay process(es) for "
                           f"{t['noun']} ({picked_dates[0]} … {picked_dates[-1]})")
            else:
                msg = f"❌ Unsupported kind for multi-select: {t['kind']}"
            ctx.user_data.get("train_picker", {}).pop(tid, None)
            await q.edit_message_text(msg, reply_markup=home_button_only())
            return

        # Stop / Restart — ask one-tap confirm
        if head in ("stop", "restart"):
            tid = parts[1]
            text, markup = render_confirm(head, tid)
            await q.edit_message_text(text, reply_markup=markup)
            return

        # Run — backtest / compare one-shot, no confirm
        if head == "run":
            tid = parts[1]
            msg = fire_run(tid)
            await q.edit_message_text(msg, reply_markup=home_button_only())
            return

        # Logs / See error
        if head == "logs":
            tid = parts[1]
            from .logs import tail_for
            text = tail_for(tid, level_filter=None)
            await q.edit_message_text(text, reply_markup=home_button_only())
            return

        # Delete sub-buttons → confirm (or picker for parquet)
        if head == "delete":
            kind = parts[1]
            if kind == "parquet":
                from .picker import available_parquet_dates
                from .._ui import render_delete_parquet_picker
                rows = available_parquet_dates()
                if not rows:
                    await q.edit_message_text("No parquet features to delete.",
                                              reply_markup=home_button_only())
                    return
                ctx.user_data["delete_parquet_sel"] = set()
                text, markup = render_delete_parquet_picker(rows, selected=set())
                await q.edit_message_text(text, reply_markup=markup)
                return
            text, markup = render_delete_confirm(kind)
            await q.edit_message_text(text, reply_markup=markup)
            return

        # Parquet-delete picker: toggle a date
        if head == "delpdt":
            date = parts[1]
            from .picker import available_parquet_dates
            from .._ui import render_delete_parquet_picker
            sel = ctx.user_data.setdefault("delete_parquet_sel", set())
            if date in sel:
                sel.discard(date)
            else:
                sel.add(date)
            rows = available_parquet_dates()
            text, markup = render_delete_parquet_picker(rows, selected=sel)
            await q.edit_message_text(text, reply_markup=markup)
            return

        # Parquet-delete picker: tap Confirm → final confirmation
        if head == "delpconf":
            sel = sorted(ctx.user_data.get("delete_parquet_sel", set()))
            if not sel:
                await q.edit_message_text("No dates selected.",
                                          reply_markup=home_button_only())
                return
            from .._ui import render_delete_parquet_confirm
            text, markup = render_delete_parquet_confirm(sel)
            await q.edit_message_text(text, reply_markup=markup)
            return

        # Shutdown two-tap flow
        if head == "shutdown":
            step = parts[1]
            if step == "confirm1":
                text, markup = render_shutdown_confirm2()
                await q.edit_message_text(text, reply_markup=markup)
                return
            if step == "confirm2":
                msg = fire_shutdown()
                await q.edit_message_text(msg)
                return
            if step == "force_with_running":
                # User saw the running-process list and chose to shut down
                # anyway. stop-all.ps1 already does the graceful Ctrl+C
                # then force-kill dance for all matched processes, then
                # initiates OS shutdown. Skip to confirm2 so they still
                # tap once more before the irreversible action.
                text, markup = render_shutdown_confirm2()
                await q.edit_message_text(text, reply_markup=markup)
                return

        # Confirmed destructive action
        if head == "do":
            action = parts[1]
            arg = parts[2]
            if action == "stop":
                msg = stop_target(arg)
            elif action == "restart":
                msg = restart_target(arg)
            elif action == "delete":
                msg = fire_delete(arg)
            elif action == "delpdates":
                # Confirmed multi-date parquet deletion. `arg` is unused
                # (this branch reads the selection back out of user_data).
                from .._runners.bats import ROOT as _root
                sel = sorted(ctx.user_data.pop("delete_parquet_sel", set()))
                if not sel:
                    msg = "No dates selected."
                else:
                    removed_files = 0
                    skipped: list[str] = []
                    for d in sel:
                        day_dir = _root / "data" / "features" / d
                        if not day_dir.exists():
                            skipped.append(d)
                            continue
                        for f in day_dir.glob("*_features.parquet"):
                            try:
                                f.unlink()
                                removed_files += 1
                            except OSError:
                                pass
                    msg = f"🗑 Deleted parquet for {len(sel) - len(skipped)} date(s) ({removed_files} file(s))"
                    if skipped:
                        msg += f"; skipped {len(skipped)} (folder missing)"
            else:
                msg = f"❓ Unknown action: {action}"
            await q.edit_message_text(msg, reply_markup=home_button_only())
            return

        # Unknown callback — fall through to home
        log.warning("unknown callback_data: %s", data)
        text, markup = render_home()
        await q.edit_message_text(text, reply_markup=markup)

    except Exception:
        log.exception("callback handler failed for data=%s", data)
        try:
            await q.edit_message_text("❌ Something went wrong. Tap below to return home.",
                                      reply_markup=home_button_only())
        except Exception:
            pass
