// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

import { SnippetPickerModal } from "@/app/modals/snippetpicker";
import { globalStore } from "@/app/store/jotaiStore";
import { LibraryModel } from "@/app/store/library-model";
import { LibraryView, LibraryViewModel } from "@/app/view/library/library";
import { atom } from "jotai";
import { useRef } from "react";

const Snippets: LibrarySnippet[] = [
    {
        id: "s1",
        title: "Follow container logs",
        body: "docker logs -f --since {{since=10m}} {{container}}",
        description: "Tail a container's logs from a point in time",
        tags: ["docker", "logs"],
        hosts: [],
    },
    {
        id: "s2",
        title: "Disk usage by folder",
        body: "du -xh --max-depth=1 {{path=/}} | sort -h",
        tags: ["disk"],
        hosts: [],
    },
    {
        id: "s3",
        title: "Postgres: biggest tables",
        body: 'sudo -u postgres psql -c "SELECT relname, pg_size_pretty(pg_total_relation_size(relid)) FROM pg_catalog.pg_statio_user_tables ORDER BY pg_total_relation_size(relid) DESC LIMIT 10;"',
        tags: ["postgres"],
        hosts: ["db*"],
    },
    {
        id: "s4",
        title: "Failed systemd units",
        body: "systemctl --failed --no-pager",
        tags: ["systemd"],
        hosts: [],
        run: true,
    },
];

const Notes: LibraryNoteInfo[] = [
    { name: "Upgrade checklist", modts: 3, size: 120, header: "Upgrade checklist" },
    { host: "admin@db1.example.com", modts: 2, size: 80, header: "Primary database" },
    { host: "admin@web1.example.com", modts: 1, size: 60, header: "Web front end" },
];

const NoteText = `# Primary database

- PostgreSQL 16, data on **/var/lib/postgresql** (separate disk)
- Nightly dump at 02:00 to the backup host
- Don't restart during business hours; replicas lag for ~2 min

\`\`\`
sudo -u postgres psql -c "SELECT now() - pg_last_xact_replay_timestamp();"
\`\`\`
`;

function seed() {
    const lib = LibraryModel.getInstance();
    lib.loading = Promise.resolve();
    globalStore.set(lib.snippetsAtom, Snippets);
    globalStore.set(lib.notesAtom, Notes);
    globalStore.set(lib.loadedAtom, true);
    lib.readNote = async () => ({ content: NoteText, modts: 2, exists: true });
    lib.writeNote = async (d) => ({ content: d.content, modts: Date.now(), exists: true });
    lib.setSnippets = (list) => globalStore.set(lib.snippetsAtom, list);
    // pretend a terminal on db1 was the last one used
    lib.isTerminal = () => true;
    lib.terminalConnection = () => "admin@db1.example.com";
    globalStore.set(lib.lastTermBlockIdAtom, "preview-term");
}

export function LibraryPreview() {
    const view = new URLSearchParams(window.location.search).get("view") ?? "snippets";
    const modelRef = useRef<LibraryViewModel>(null);
    if (modelRef.current == null) {
        seed();
        const env = {
            atoms: {
                fullConfigAtom: atom({
                    connections: { "admin@db1.example.com": {}, "admin@web1.example.com": {} },
                } as unknown as FullConfigType),
            },
            createBlock: async () => "",
        };
        const model = new LibraryViewModel({
            blockId: "preview-library",
            waveEnv: env,
        } as unknown as ViewModelInitType);
        if (view === "notes") {
            globalStore.set(model.tabAtom, "notes");
            globalStore.set(model.selectedNoteAtom, { host: "admin@db1.example.com" });
        } else if (view === "fill") {
            globalStore.set(model.fillingAtom, Snippets[0]);
        } else {
            globalStore.set(model.selectedSnippetAtom, "s3");
        }
        modelRef.current = model;
    }
    if (view === "picker") {
        return (
            <div className="relative h-[520px] w-[900px] bg-background">
                <SnippetPickerModal termBlockId="preview-term" />
            </div>
        );
    }
    return (
        <div className="h-[560px] w-[900px] overflow-hidden rounded border border-border bg-background text-foreground">
            <LibraryView blockId="preview-library" model={modelRef.current} blockRef={null} contentRef={null} />
        </div>
    );
}
