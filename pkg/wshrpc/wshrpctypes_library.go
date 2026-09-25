// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

package wshrpc

// LibrarySnippet is one saved command. Body may contain {{name}} / {{name=default}} placeholders that
// are filled in before the text is inserted into a terminal.
type LibrarySnippet struct {
	Id          string   `json:"id"`
	Title       string   `json:"title"`
	Body        string   `json:"body"`
	Description string   `json:"description,omitempty"`
	Tags        []string `json:"tags,omitempty"`
	// connection-name patterns (glob, e.g. "*.example.com", "db*"); matching hosts list the snippet first
	Hosts []string `json:"hosts,omitempty"`
	// press Enter after inserting (default is to leave the command at the prompt)
	Run bool `json:"run,omitempty"`
}

// LibraryData is the content of library.json in the Wave config directory.
type LibraryData struct {
	Snippets []LibrarySnippet `json:"snippets"`
}

type LibraryNoteInfo struct {
	// file name without .md for general notes; empty for host notes
	Name string `json:"name,omitempty"`
	// connection name for a host note
	Host   string `json:"host,omitempty"`
	ModTs  int64  `json:"modts"`
	Size   int64  `json:"size"`
	Header string `json:"header,omitempty"`
}

type CommandLibraryNoteRefData struct {
	Name string `json:"name,omitempty"`
	Host string `json:"host,omitempty"`
}

type LibraryNoteData struct {
	Content string `json:"content"`
	ModTs   int64  `json:"modts"`
	Exists  bool   `json:"exists"`
}

type CommandLibraryNoteWriteData struct {
	Name    string `json:"name,omitempty"`
	Host    string `json:"host,omitempty"`
	Content string `json:"content"`
	// modts of the version the editor started from; the write is refused if the file changed since
	// (edited outside Wave). 0 means "create or overwrite".
	BaseModTs int64 `json:"basemodts,omitempty"`
}
