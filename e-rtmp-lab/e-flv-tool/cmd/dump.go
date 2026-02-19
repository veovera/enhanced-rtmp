package cmd

import (
	"eflv/flv"

	"github.com/spf13/cobra"
)

var (
	dumpJSON    bool
	dumpVerbose bool
)

var dumpCmd = &cobra.Command{
	Use:   "dump <input.flv>",
	Short: "Dump structural information about an FLV / E-FLV file",
	Long: `Dump structural information about an FLV / E-FLV file.

Includes:
  - Header info
  - Tag summary
  - Metadata/script data
  - Track information (if present)`,
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		return flv.DumpFLV(args[0], dumpJSON, dumpVerbose)
	},
}

func init() {
	dumpCmd.Flags().BoolVar(&dumpJSON, "json", false, "Output machine-readable JSON instead of text")
	dumpCmd.Flags().BoolVar(&dumpVerbose, "verbose", false, "Include lower-level details (offsets, timestamps, tag counts)")
	rootCmd.AddCommand(dumpCmd)
}
