from src import ai
from src.media.covers import balance_cover_lines, cover_size


def test_cover_lines_are_balanced_and_upper_case():
    assert balance_cover_lines("ele não esperava essa reação do chat") == [
        "ELE NÃO ESPERAVA", "ESSA REAÇÃO DO CHAT",
    ]
    assert balance_cover_lines("  uau  ") == ["UAU"]
    assert balance_cover_lines("") == []


def test_cover_size_follows_the_clip_shape():
    assert cover_size(1080, 1920) == (1080, 1920)
    assert cover_size(1920, 1080) == (1280, 720)
    assert cover_size(1080, 1080) == (1080, 1080)


def test_post_text_prompt_and_cleanup():
    prompt = ai.build_post_texts_prompt("fala do clipe", "Título forte", "tom engraçado")
    assert "Título forte" in prompt and "fala do clipe" in prompt and "tom engraçado" in prompt
    assert "CREATOR'S EXTRA REQUEST" not in ai.build_post_texts_prompt("fala", None, "  ")
    assert ai._clean_post_text("isso — aquilo", 100) == "isso, aquilo"
