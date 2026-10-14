Feature: Ask what governs a path before writing it, then let check catch a bypass

  An agent about to create a file asks archstrict which module it falls in
  and which files of other modules it may import. If it imports past a
  module's public surface anyway, check names the rule, the line, and the
  command that fixes it, and following that command makes check pass.

  Scenario: an import past a module's public surface is reported with a fix, and the fix passes
    Given a project whose billing and orders directories are declared modules by archstrict init
    When the agent asks archstrict which rules govern a new file in orders
    Then the answer names orders as its module and billing's index file as the way into billing
    When the agent writes that file with an import of a billing file other than its index
    Then check reports one public-surface-bypass violation whose do: line names billing's index
    When the agent follows the do: line
    Then check passes with no violation
