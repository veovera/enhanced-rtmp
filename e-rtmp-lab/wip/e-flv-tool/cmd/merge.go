package cmd

import (
	"eflv/flv"

	"github.com/spf13/cobra"
)

var (
	mergeOutput     string
	mergeMultitrack bool
)

var mergeCmd = &cobra.Command{
	Use:   "merge <a.flv> <b.flv>",
	Short: "Merge two E-FLV inputs into a single output FLV",
	Long: `Merge two E-FLV inputs into a single output FLV.

When --multitrack is specified, preserve each input as a separate
track group in the output. Output remains a valid .flv file.`,
	Args: cobra.ExactArgs(2),
	RunE: func(cmd *cobra.Command, args []string) error {
		return flv.MergeFLV(args[0], args[1], mergeOutput, mergeMultitrack)
	},
}

func init() {
	mergeCmd.Flags().StringVarP(&mergeOutput, "output", "o", "", "Output file path (required)")
	mergeCmd.MarkFlagRequired("output")
	mergeCmd.Flags().BoolVar(&mergeMultitrack, "multitrack", false, "Preserve each input as a separate track group")
	rootCmd.AddCommand(mergeCmd)
}
