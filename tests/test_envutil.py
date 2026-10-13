from shiwu.envutil import getenv
from shiwu.paths import data_dir


def test_getenv_first_nonempty(monkeypatch, tmp_path):
    monkeypatch.setenv("SHIWU_DATA_DIR", str(tmp_path / "data"))
    assert getenv("SHIWU_DATA_DIR") == str(tmp_path / "data")
    assert data_dir() == tmp_path / "data"
    assert (tmp_path / "data").is_dir()


def test_fake_cameras(monkeypatch):
    from shiwu.stream.sources import camera_source as cs
    monkeypatch.setenv("SHIWU_FAKE_CAMERAS", "9=/tmp/a.mp4")
    assert cs.fake_cameras().get("9") == "/tmp/a.mp4"
