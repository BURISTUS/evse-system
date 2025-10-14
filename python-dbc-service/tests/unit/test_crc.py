import pytest
from utils.crc import CRC16ARC


class TestCRC16ARC:
    def test_calculate_empty(self):
        """Тест для пустых данных"""
        result = CRC16ARC.calculate(b"")
        assert result == 0x0000

    def test_calculate_known_value(self):
        """Тест с известным test vector"""
        data = b"123456789"
        result = CRC16ARC.calculate(data)
        assert result == 0xBB3D

    def test_calculate_single_byte(self):
        """Тест с одним байтом"""
        result = CRC16ARC.calculate(b"\x00")
        assert result == 0x0000
        result = CRC16ARC.calculate(b"\xFF")
        assert result == 0x4040

    def test_calculate_multiple_patterns(self):
        """Тест с различными паттернами данных"""
        # Все единицы
        result = CRC16ARC.calculate(b"\xFF" * 8)
        assert isinstance(result, int)
        assert 0 <= result <= 0xFFFF
        
        # Чередующиеся биты
        result = CRC16ARC.calculate(b"\xAA\x55" * 4)
        assert isinstance(result, int)
        assert 0 <= result <= 0xFFFF

    def test_calculate_large_data(self):
        """Тест с большим объемом данных"""
        large_data = b"A" * 1000
        result = CRC16ARC.calculate(large_data)
        assert isinstance(result, int)
        assert 0 <= result <= 0xFFFF

    def test_verify_correct(self):
        """Тест корректной верификации"""
        data = b"test_data"
        crc = CRC16ARC.calculate(data)
        assert CRC16ARC.verify(data, crc) is True

    def test_verify_incorrect(self):
        """Тест некорректной верификации"""
        data = b"test_data"
        wrong_crc = 0x0000
        assert CRC16ARC.verify(data, wrong_crc) is False

    def test_verify_edge_cases(self):
        """Тест граничных случаев верификации"""
        # Максимальный CRC
        assert CRC16ARC.verify(b"", 0x0000) is True
        
        # Неправильный максимальный CRC
        assert CRC16ARC.verify(b"test", 0xFFFF) is False

    def test_crc_consistency(self):
        """Тест консистентности CRC для одних данных"""
        data = b"consistency_test"
        crc1 = CRC16ARC.calculate(data)
        crc2 = CRC16ARC.calculate(data)
        assert crc1 == crc2
