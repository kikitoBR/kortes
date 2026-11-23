"""file_lock behaves like fcntl.flock on Linux and Windows."""

import pytest

from src import file_lock


def test_exclusive_locks_conflict_between_opens(tmp_path):
    path = tmp_path / ".lock"
    with path.open("a") as first, path.open("a") as second:
        file_lock.flock(first, file_lock.LOCK_EX)
        with pytest.raises(BlockingIOError):
            file_lock.flock(second, file_lock.LOCK_EX | file_lock.LOCK_NB)
        file_lock.flock(first, file_lock.LOCK_UN)
        file_lock.flock(second, file_lock.LOCK_EX | file_lock.LOCK_NB)


def test_shared_locks_coexist_but_block_an_exclusive_one(tmp_path):
    path = tmp_path / ".lease"
    with path.open("a") as reader, path.open("a") as other_reader, path.open("a") as writer:
        file_lock.flock(reader, file_lock.LOCK_SH)
        file_lock.flock(other_reader, file_lock.LOCK_SH | file_lock.LOCK_NB)
        with pytest.raises(BlockingIOError):
            file_lock.flock(writer, file_lock.LOCK_EX | file_lock.LOCK_NB)


def test_closing_the_file_releases_its_lock(tmp_path):
    path = tmp_path / ".download"
    with path.open("a") as holder:
        file_lock.flock(holder, file_lock.LOCK_EX)
    with path.open("a") as next_holder:
        file_lock.flock(next_holder, file_lock.LOCK_EX | file_lock.LOCK_NB)


def test_a_locked_file_can_still_be_written(tmp_path):
    path = tmp_path / ".lock"
    with path.open("a") as holder, path.open("a") as writer:
        file_lock.flock(holder, file_lock.LOCK_EX)
        writer.write("still writable")
    assert path.read_text() == "still writable"
