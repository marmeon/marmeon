// The value types of the lab's JSON columns, by `'<table>.<column>'`. Nothing checks them: a row written by raw SQL reads as it is.
declare module '@marmeon/database' {
  interface JsonTypes {
    /** The words a choice offers; `SurveyRepository` checks them with `OptionsRule` before it writes. */
    'lab_survey_questions.options': readonly string[];
  }
}

export {};
