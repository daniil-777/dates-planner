/**
 * Presentation layer for the domain model.
 *
 * Kept out of schema.cds on purpose: the schema is the contract, this file is
 * taste. Everything here is standard OData vocabulary annotation, so a Fiori
 * elements List Report / Object Page can be generated off LedgerService.Expenses
 * without writing a single line of UI code (see docs prompt 16).
 */
using {twowaymatch as twm} from './schema';


/* ------------------------------------------------------------------ *
 *  Labels
 * ------------------------------------------------------------------ */

annotate twm.People with @(
  title             : 'Person',
  Common.Label      : 'Person',
  UI.HeaderInfo     : {
    $Type          : 'UI.HeaderInfoType',
    TypeName       : 'Person',
    TypeNamePlural : 'People',
    Title          : {
      $Type : 'UI.DataField',
      Value : name,
    },
    Description    : {
      $Type : 'UI.DataField',
      Value : email,
    },
  },
  UI.Identification : [{
    $Type : 'UI.DataField',
    Value : name,
  }],
  UI.LineItem       : [
    {
      $Type : 'UI.DataField',
      Value : name,
    },
    {
      $Type : 'UI.DataField',
      Value : email,
    },
    {
      $Type : 'UI.DataField',
      Value : isDefault,
    },
  ],
) {
  ID        @(title: 'Person ID', Common.Label: 'Person ID', UI.Hidden);
  name      @(title: 'Name', Common.Label: 'Name');
  colour    @(title: 'Colour', Common.Label: 'Avatar Colour');
  email     @(title: 'Email', Common.Label: 'Email');
  isDefault @(title: 'Household', Common.Label: 'Part of the Household');
}

annotate twm.Events with @(
  title         : 'Event',
  Common.Label  : 'Event',
  UI.HeaderInfo : {
    $Type          : 'UI.HeaderInfoType',
    TypeName       : 'Event',
    TypeNamePlural : 'Events',
    Title          : {
      $Type : 'UI.DataField',
      Value : name,
    },
    Description    : {
      $Type : 'UI.DataField',
      Value : place,
    },
  },
  UI.LineItem   : [
    {
      $Type            : 'UI.DataField',
      Value            : startsOn,
      ![@UI.Importance]: #High,
    },
    {
      $Type            : 'UI.DataField',
      Value            : name,
      ![@UI.Importance]: #High,
    },
    {
      $Type            : 'UI.DataField',
      Value            : place,
      ![@UI.Importance]: #Medium,
    },
    {
      $Type            : 'UI.DataField',
      Value            : endsOn,
      ![@UI.Importance]: #Low,
    },
    {
      $Type            : 'UI.DataField',
      Value            : isSurprise,
      ![@UI.Importance]: #Low,
    },
  ],
  UI.Facets     : [
    {
      $Type  : 'UI.ReferenceFacet',
      ID     : 'EventDetailsFacet',
      Label  : 'Event',
      Target : '@UI.FieldGroup#EventDetails',
    },
    {
      $Type  : 'UI.ReferenceFacet',
      ID     : 'ParticipantsFacet',
      Label  : 'Participants',
      Target : 'participants/@UI.LineItem',
    },
  ],

  UI.FieldGroup #EventDetails: {
    $Type : 'UI.FieldGroupType',
    Data  : [
      {
        $Type : 'UI.DataField',
        Value : name,
      },
      {
        $Type : 'UI.DataField',
        Value : startsOn,
      },
      {
        $Type : 'UI.DataField',
        Value : endsOn,
      },
      {
        $Type : 'UI.DataField',
        Value : place,
      },
      {
        $Type : 'UI.DataField',
        Value : note,
      },
      {
        $Type : 'UI.DataField',
        Value : isSurprise,
      },
      {
        $Type : 'UI.DataField',
        Value : createdBy_ID,
      },
      {
        $Type : 'UI.DataField',
        Value : revealedAt,
      },
    ],
  },
) {
  ID           @(title: 'Event ID', Common.Label: 'Event ID', UI.Hidden);
  name         @(title: 'Event', Common.Label: 'Event Name');
  startsOn     @(title: 'Starts', Common.Label: 'Starts On');
  endsOn       @(title: 'Ends', Common.Label: 'Ends On');
  place        @(title: 'Place', Common.Label: 'Place');
  note         @(title: 'Note', Common.Label: 'Note', UI.MultiLineText);
  participants @(title: 'Participants', Common.Label: 'Participants');
  photos       @(title: 'Photos', Common.Label: 'Photos');
  reminders    @(title: 'Reminders', Common.Label: 'Reminders');
  isSurprise   @(title: 'Surprise', Common.Label: 'Surprise');
  createdBy    @(
    title  : 'Planned By',
    Common : {
      Label                   : 'Planned By',
      Text                    : createdBy.name,
      TextArrangement         : #TextOnly,
      ValueListWithFixedValues: true,
      ValueList               : {
        $Type         : 'Common.ValueListType',
        Label         : 'Planned By',
        CollectionPath: 'People',
        Parameters    : [
          {
            $Type            : 'Common.ValueListParameterInOut',
            LocalDataProperty: createdBy_ID,
            ValueListProperty: 'ID',
          },
          {
            $Type            : 'Common.ValueListParameterDisplayOnly',
            ValueListProperty: 'name',
          },
        ],
      },
    },
  );
  revealedAt   @(title: 'Revealed At', Common.Label: 'Revealed At');
  expenses     @(title: 'Postings', Common.Label: 'Postings');
}

/**
 * Pictures of an event. Labelled like `Photos` on a memory, because to anybody
 * reading the screen they are the same thing (CONTRACTS.md §11.1).
 */
annotate twm.EventPhotos with @(
  title       : 'Event Photo',
  Common.Label: 'Event Photo',
) {
  ID        @(title: 'Photo ID', Common.Label: 'Photo ID', UI.Hidden);
  event     @(title: 'Event', Common.Label: 'Event');
  image     @(title: 'Image', Common.Label: 'Image');
  mediaType @(title: 'Media Type', Common.Label: 'Media Type');
  caption   @(title: 'Caption', Common.Label: 'Caption');
  takenOn   @(title: 'Taken On', Common.Label: 'Taken On');
}

/** A nudge before an event starts (CONTRACTS.md §11.2). */
annotate twm.Reminders with @(
  title        : 'Reminder',
  Common.Label : 'Reminder',
  UI.LineItem  : [
    {
      $Type : 'UI.DataField',
      Value : event_ID,
    },
    {
      $Type : 'UI.DataField',
      Value : leadDays,
    },
    {
      $Type : 'UI.DataField',
      Value : note,
    },
    {
      $Type : 'UI.DataField',
      Value : done,
    },
  ],
) {
  ID       @(title: 'Reminder ID', Common.Label: 'Reminder ID', UI.Hidden);
  event    @(title: 'Event', Common.Label: 'Event');
  leadDays @(title: 'Lead Days', Common.Label: 'Days Before It Starts');
  note     @(title: 'Note', Common.Label: 'Note');
  done     @(title: 'Done', Common.Label: 'Done');
}

annotate twm.EventParticipants with @(
  title        : 'Participant',
  Common.Label : 'Participant',
  UI.LineItem  : [{
    $Type : 'UI.DataField',
    Value : person_ID,
  }],
) {
  event  @(title: 'Event', Common.Label: 'Event', UI.Hidden);
  person @(
    title  : 'Person',
    Common : {
      Label                   : 'Person',
      Text                    : person.name,
      TextArrangement         : #TextOnly,
      ValueListWithFixedValues: true,
      ValueList               : {
        $Type         : 'Common.ValueListType',
        Label         : 'Person',
        CollectionPath: 'People',
        Parameters    : [
          {
            $Type            : 'Common.ValueListParameterInOut',
            LocalDataProperty: person_ID,
            ValueListProperty: 'ID',
          },
          {
            $Type            : 'Common.ValueListParameterDisplayOnly',
            ValueListProperty: 'name',
          },
          {
            $Type            : 'Common.ValueListParameterDisplayOnly',
            ValueListProperty: 'email',
          },
        ],
      },
    },
  );
}

annotate twm.Categories with @(
  title        : 'Category',
  Common.Label : 'Category',
  UI.LineItem  : [
    {
      $Type : 'UI.DataField',
      Value : code,
    },
    {
      $Type : 'UI.DataField',
      Value : name,
    },
    {
      $Type : 'UI.DataField',
      Value : sortOrder,
    },
  ],
) {
  code      @(
    title  : 'Category Code',
    Common : {
      Label          : 'Category Code',
      Text           : name,
      TextArrangement: #TextOnly,
    }
  );
  name      @(title: 'Category', Common.Label: 'Category');
  icon      @(title: 'Icon', Common.Label: 'Icon');
  colour    @(title: 'Colour', Common.Label: 'Colour');
  sortOrder @(title: 'Sort Order', Common.Label: 'Sort Order');
}

annotate twm.Expenses with {
  ID                 @(title: 'Expense ID', Common.Label: 'Expense ID', UI.Hidden);
  documentNumber     @(title: 'Document', Common.Label: 'Document Number');
  date               @(title: 'Date', Common.Label: 'Posting Date');
  time               @(title: 'Time', Common.Label: 'Time');
  merchantRaw        @(title: 'Merchant', Common.Label: 'Merchant');
  merchantNorm       @(
    title       : 'Merchant (normalised)',
    Common.Label: 'Merchant (normalised)',
    UI.Hidden
  );
  amount             @(
    title               : 'Amount',
    Common.Label        : 'Amount',
    Measures.ISOCurrency: currency
  );
  currency           @(title: 'Currency', Common.Label: 'Currency');
  categoryConfidence @(title: 'Category Confidence', Common.Label: 'Category Confidence');
  moment             @(title: 'Moment', Common.Label: 'Moment');
  momentConfidence   @(title: 'Moment Confidence', Common.Label: 'Moment Confidence');
  status             @(title: 'Status', Common.Label: 'Status');
  source             @(title: 'Source', Common.Label: 'Source');
  note               @(title: 'Note', Common.Label: 'Note', UI.MultiLineText);
  place              @(title: 'Place', Common.Label: 'Place');
  lat                @(title: 'Latitude', Common.Label: 'Latitude');
  lon                @(title: 'Longitude', Common.Label: 'Longitude');
  receipt            @(title: 'Receipt', Common.Label: 'Receipt');
  settlement         @(title: 'Clearing', Common.Label: 'Clearing Document');
  memories           @(title: 'Memories', Common.Label: 'Memories');
  corrections        @(title: 'Corrections', Common.Label: 'Corrections');
}

annotate twm.Receipts with @(
  title       : 'Receipt',
  Common.Label: 'Receipt',
) {
  ID               @(title: 'Receipt ID', Common.Label: 'Receipt ID', UI.Hidden);
  image            @(title: 'Image', Common.Label: 'Image');
  mediaType        @(title: 'Media Type', Common.Label: 'Media Type');
  fileName         @(title: 'File Name', Common.Label: 'File Name');
  docaiJobId       @(title: 'Document AI Job', Common.Label: 'Document AI Job');
  extraction       @(title: 'Extraction', Common.Label: 'Raw Extraction', UI.MultiLineText);
  extractionStatus @(title: 'Extraction Status', Common.Label: 'Extraction Status');
}

annotate twm.Memories with @(
  title         : 'Memory',
  Common.Label  : 'Memory',
  UI.HeaderInfo : {
    $Type          : 'UI.HeaderInfoType',
    TypeName       : 'Memory',
    TypeNamePlural : 'Memories',
    Title          : {
      $Type : 'UI.DataField',
      Value : title,
    },
    Description    : {
      $Type : 'UI.DataField',
      Value : occurredOn,
    },
  },
  UI.LineItem   : [
    {
      $Type : 'UI.DataField',
      Value : occurredOn,
    },
    {
      $Type : 'UI.DataField',
      Value : title,
    },
    {
      $Type : 'UI.DataField',
      Value : kind,
    },
    {
      $Type : 'UI.DataField',
      Value : place,
    },
    {
      $Type : 'UI.DataField',
      Value : pinned,
    },
  ],
) {
  ID         @(title: 'Memory ID', Common.Label: 'Memory ID', UI.Hidden);
  expense    @(title: 'Expense', Common.Label: 'Related Expense');
  title      @(title: 'Title', Common.Label: 'Title');
  note       @(title: 'Note', Common.Label: 'Note', UI.MultiLineText);
  occurredOn @(title: 'Date', Common.Label: 'Happened On');
  kind       @(title: 'Kind', Common.Label: 'Kind');
  pinned     @(title: 'Pinned', Common.Label: 'Pinned');
  place      @(title: 'Place', Common.Label: 'Place');
  lat        @(title: 'Latitude', Common.Label: 'Latitude');
  lon        @(title: 'Longitude', Common.Label: 'Longitude');
  photos     @(title: 'Photos', Common.Label: 'Photos');
}

annotate twm.Photos with @(
  title       : 'Photo',
  Common.Label: 'Photo',
) {
  ID        @(title: 'Photo ID', Common.Label: 'Photo ID', UI.Hidden);
  memory    @(title: 'Memory', Common.Label: 'Memory');
  image     @(title: 'Image', Common.Label: 'Image');
  mediaType @(title: 'Media Type', Common.Label: 'Media Type');
  caption   @(title: 'Caption', Common.Label: 'Caption');
}

annotate twm.Settlements with @(
  title         : 'Clearing Document',
  Common.Label  : 'Clearing Document',
  UI.HeaderInfo : {
    $Type          : 'UI.HeaderInfoType',
    TypeName       : 'Clearing Document',
    TypeNamePlural : 'Clearing Documents',
    Title          : {
      $Type : 'UI.DataField',
      Value : clearingDocument,
    },
    Description    : {
      $Type : 'UI.DataField',
      Value : period,
    },
  },
  UI.LineItem   : [
    {
      $Type : 'UI.DataField',
      Value : period,
    },
    {
      $Type : 'UI.DataField',
      Value : clearingDocument,
    },
    {
      $Type : 'UI.DataField',
      Value : grandTotal,
    },
    {
      $Type : 'UI.DataField',
      Value : status,
    },
  ],
) {
  ID               @(title: 'Settlement ID', Common.Label: 'Settlement ID', UI.Hidden);
  period           @(title: 'Period', Common.Label: 'Period (YYYY-MM)');
  grandTotal       @(title: 'Total', Common.Label: 'Total Posted in the Period');
  status           @(title: 'Status', Common.Label: 'Status');
  settledAt        @(title: 'Closed At', Common.Label: 'Closed At');
  clearingDocument @(title: 'Clearing Document', Common.Label: 'Clearing Document');
  approvedBy       @(title: 'Approved By', Common.Label: 'Approved By');
  expenses         @(title: 'Covered Items', Common.Label: 'Covered Items');
}

annotate twm.Statements with @(
  title       : 'Statement of Us',
  Common.Label: 'Statement of Us',
) {
  ID              @(title: 'Statement ID', Common.Label: 'Statement ID', UI.Hidden);
  year            @(title: 'Year', Common.Label: 'Reporting Year');
  contentMarkdown @(title: 'Statement', Common.Label: 'Statement', UI.MultiLineText);
  generatedAt     @(title: 'Generated At', Common.Label: 'Generated At');
  engine          @(title: 'Engine', Common.Label: 'Generating Engine');
}

annotate twm.Corrections with @(
  title        : 'Correction',
  Common.Label : 'Correction',
  UI.LineItem  : [
    {
      $Type : 'UI.DataField',
      Value : createdAt,
    },
    {
      $Type : 'UI.DataField',
      Value : field,
    },
    {
      $Type : 'UI.DataField',
      Value : predicted,
    },
    {
      $Type : 'UI.DataField',
      Value : corrected,
    },
  ],
) {
  ID        @(title: 'Correction ID', Common.Label: 'Correction ID', UI.Hidden);
  expense   @(title: 'Expense', Common.Label: 'Expense');
  field     @(title: 'Field', Common.Label: 'Corrected Field');
  predicted @(title: 'Predicted', Common.Label: 'Model Prediction');
  corrected @(title: 'Corrected', Common.Label: 'Human Correction');
  createdAt @(title: 'Logged At', Common.Label: 'Logged At');
}


/* ------------------------------------------------------------------ *
 *  Value helps
 *
 *  All three target entities are small and stable, so they are marked
 *  ValueListWithFixedValues: Fiori renders a dropdown instead of a dialog.
 * ------------------------------------------------------------------ */

annotate twm.Expenses with {
  category @(
    title  : 'Category',
    Common : {
      Label                   : 'Category',
      Text                    : category.name,
      TextArrangement         : #TextOnly,
      ValueListWithFixedValues: true,
      ValueList               : {
        $Type         : 'Common.ValueListType',
        Label         : 'Category',
        CollectionPath: 'Categories',
        Parameters    : [
          {
            $Type            : 'Common.ValueListParameterInOut',
            LocalDataProperty: category_code,
            ValueListProperty: 'code',
          },
          {
            $Type            : 'Common.ValueListParameterDisplayOnly',
            ValueListProperty: 'name',
          },
          {
            $Type            : 'Common.ValueListParameterDisplayOnly',
            ValueListProperty: 'icon',
          },
        ],
      },
    },
  );

  paidBy   @(
    title  : 'Paid By',
    Common : {
      Label                   : 'Paid By',
      Text                    : paidBy.name,
      TextArrangement         : #TextOnly,
      ValueListWithFixedValues: true,
      ValueList               : {
        $Type         : 'Common.ValueListType',
        Label         : 'Paid By',
        CollectionPath: 'People',
        Parameters    : [
          {
            $Type            : 'Common.ValueListParameterInOut',
            LocalDataProperty: paidBy_ID,
            ValueListProperty: 'ID',
          },
          {
            $Type            : 'Common.ValueListParameterDisplayOnly',
            ValueListProperty: 'name',
          },
          {
            $Type            : 'Common.ValueListParameterDisplayOnly',
            ValueListProperty: 'email',
          },
        ],
      },
    },
  );

  event    @(
    title  : 'Event',
    Common : {
      Label                   : 'Event',
      Text                    : event.name,
      TextArrangement         : #TextOnly,
      ValueListWithFixedValues: true,
      ValueList               : {
        $Type         : 'Common.ValueListType',
        Label         : 'Event',
        CollectionPath: 'Events',
        Parameters    : [
          {
            $Type            : 'Common.ValueListParameterInOut',
            LocalDataProperty: event_ID,
            ValueListProperty: 'ID',
          },
          {
            $Type            : 'Common.ValueListParameterDisplayOnly',
            ValueListProperty: 'name',
          },
          {
            $Type            : 'Common.ValueListParameterDisplayOnly',
            ValueListProperty: 'startsOn',
          },
        ],
      },
    },
  );
}


/* ------------------------------------------------------------------ *
 *  Expenses — List Report + Object Page
 * ------------------------------------------------------------------ */

annotate twm.Expenses with @(
  title             : 'Expense',
  Common.Label      : 'Expense',
  UI.HeaderInfo     : {
    $Type          : 'UI.HeaderInfoType',
    TypeName       : 'Expense',
    TypeNamePlural : 'Expenses',
    Title          : {
      $Type : 'UI.DataField',
      Value : merchantRaw,
    },
    Description    : {
      $Type : 'UI.DataField',
      Value : documentNumber,
    },
    ImageUrl       : receipt.image,
  },

  UI.SelectionFields: [
    date,
    category_code,
    moment,
    paidBy_ID,
    event_ID,
    status,
  ],

  UI.LineItem       : [
    {
      $Type            : 'UI.DataField',
      Value            : documentNumber,
      ![@UI.Importance]: #High,
    },
    {
      $Type            : 'UI.DataField',
      Value            : date,
      ![@UI.Importance]: #High,
    },
    {
      $Type            : 'UI.DataField',
      Value            : merchantRaw,
      ![@UI.Importance]: #High,
    },
    {
      $Type            : 'UI.DataField',
      Value            : category_code,
      ![@UI.Importance]: #High,
    },
    {
      $Type            : 'UI.DataField',
      Value            : moment,
      ![@UI.Importance]: #Medium,
    },
    {
      $Type            : 'UI.DataField',
      Value            : amount,
      ![@UI.Importance]: #High,
    },
    {
      $Type            : 'UI.DataField',
      Value            : paidBy_ID,
      ![@UI.Importance]: #Medium,
    },
    {
      $Type            : 'UI.DataField',
      Value            : event_ID,
      ![@UI.Importance]: #Low,
    },
    {
      $Type            : 'UI.DataField',
      Value            : status,
      ![@UI.Importance]: #Low,
    },
  ],

  UI.FieldGroup #Posting       : {
    $Type : 'UI.FieldGroupType',
    Data  : [
      {
        $Type : 'UI.DataField',
        Value : documentNumber,
      },
      {
        $Type : 'UI.DataField',
        Value : date,
      },
      {
        $Type : 'UI.DataField',
        Value : time,
      },
      {
        $Type : 'UI.DataField',
        Value : merchantRaw,
      },
      {
        $Type : 'UI.DataField',
        Value : place,
      },
      {
        $Type : 'UI.DataField',
        Value : amount,
      },
      {
        $Type : 'UI.DataField',
        Value : currency,
      },
      {
        $Type : 'UI.DataField',
        Value : status,
      },
      {
        $Type : 'UI.DataField',
        Value : source,
      },
    ],
  },

  UI.FieldGroup #Classification: {
    $Type : 'UI.FieldGroupType',
    Data  : [
      {
        $Type : 'UI.DataField',
        Value : category_code,
      },
      {
        $Type : 'UI.DataField',
        Value : categoryConfidence,
      },
      {
        $Type : 'UI.DataField',
        Value : moment,
      },
      {
        $Type : 'UI.DataField',
        Value : momentConfidence,
      },
    ],
  },

  UI.FieldGroup #Attribution   : {
    $Type : 'UI.FieldGroupType',
    Data  : [
      {
        $Type : 'UI.DataField',
        Value : paidBy_ID,
      },
      {
        $Type : 'UI.DataField',
        Value : event_ID,
      },
      {
        $Type : 'UI.DataField',
        Value : settlement_ID,
      },
    ],
  },

  UI.FieldGroup #Context       : {
    $Type : 'UI.FieldGroupType',
    Data  : [
      {
        $Type : 'UI.DataField',
        Value : note,
      },
      {
        $Type : 'UI.DataField',
        Value : lat,
      },
      {
        $Type : 'UI.DataField',
        Value : lon,
      },
      {
        $Type : 'UI.DataField',
        Value : receipt_ID,
      },
    ],
  },

  UI.Facets         : [
    {
      $Type  : 'UI.ReferenceFacet',
      ID     : 'PostingFacet',
      Label  : 'Posting',
      Target : '@UI.FieldGroup#Posting',
    },
    {
      $Type  : 'UI.ReferenceFacet',
      ID     : 'ClassificationFacet',
      Label  : 'Two-Way Match',
      Target : '@UI.FieldGroup#Classification',
    },
    {
      $Type  : 'UI.ReferenceFacet',
      ID     : 'AttributionFacet',
      Label  : 'Paid By and Event',
      Target : '@UI.FieldGroup#Attribution',
    },
    {
      $Type  : 'UI.ReferenceFacet',
      ID     : 'ContextFacet',
      Label  : 'Context',
      Target : '@UI.FieldGroup#Context',
    },
  ],
);
