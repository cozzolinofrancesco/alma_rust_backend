pub trait LendingRecordCursor {
    type LentRecord<'borrow>
    where
        Self: 'borrow;

    fn advance_to_next_record<'borrow>(&'borrow mut self) -> Option<Self::LentRecord<'borrow>>;
}

pub struct OwnedRecordLendingCursor<StoredRecord> {
    stored_records: Vec<StoredRecord>,
    current_position: usize,
}

impl<StoredRecord> OwnedRecordLendingCursor<StoredRecord> {
    pub fn over(stored_records: Vec<StoredRecord>) -> Self {
        Self {
            stored_records,
            current_position: 0,
        }
    }
}

impl<StoredRecord> LendingRecordCursor for OwnedRecordLendingCursor<StoredRecord> {
    type LentRecord<'borrow>
        = &'borrow StoredRecord
    where
        Self: 'borrow;

    fn advance_to_next_record<'borrow>(&'borrow mut self) -> Option<&'borrow StoredRecord> {
        let borrowed_record = self.stored_records.get(self.current_position)?;
        self.current_position += 1;
        Some(borrowed_record)
    }
}
