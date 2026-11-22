Feature: An entry is numbered when it ships, never fought over

  Scenario: Into production, without integration branch, the merge keeps it next
    Given the production branch's newest version is "0.83"
    And two pull requests each add an entry "next", for stories #195 and #196
    When the merge workflow merges one, then the other
    Then both entries are on top, "next", without time, and no merge conflicts on the release notes
    And closing the sprint with #195 done makes version "0.84", dated and timed, the entry of #196 still "next"

  Scenario: Into an integration branch, the merge numbers it without time
    Given the integration branch's newest version is "1.178"
    And two pull requests were both written with version "1.179", for stories #249 and #251
    When the merge workflow merges #249's, then #251's
    Then they are "1.179" and "1.180", dated, without time, and no merge conflicts on the release notes
    And the go makes them one version, dated and timed

  Scenario: The project runs La Fabrique's tool, not its own
    Given a project declares its copy of the release-notes tool in version.outil
    Then its first line says "FabriqueReleaseNotes" and the version of La Fabrique's kit/release-notes.js
