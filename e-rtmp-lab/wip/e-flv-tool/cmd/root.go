package cmd

import "github.com/spf13/cobra"

var rootCmd = &cobra.Command{
	Use:           "eflv",
	Short:         "A general FLV / E-FLV utility",
	Long:          "eflv is a command-line tool for inspecting and manipulating FLV and E-FLV files.",
	SilenceErrors: true,
	SilenceUsage:  true,
}

func Execute() error {
	return rootCmd.Execute()
}
