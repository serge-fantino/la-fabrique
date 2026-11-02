Feature: An entry is numbered when it ships

  Scenario: The merge gives the number and the time
    Given the production branch's newest version is "0.83"
    And a pull request adds an entry "next" that declares story #195
    When the merge workflow merges the pull request at 17:12 (Paris)
    Then the entry becomes version "0.84" with the time "17:12"
    And "What's new" shows "0.84" first, with story #195 linked to its issue
