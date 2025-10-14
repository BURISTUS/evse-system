import pytest
from datetime import datetime
from pydantic import ValidationError
from core.models import CommAddr, CommData, ParsedMessage


class TestCommAddr:
    def test_valid_creation(self):
        """Тест корректного создания CommAddr"""
        addr = CommAddr(dev_addr=1, msg_id=100, reserved=0)
        assert addr.dev_addr == 1
        assert addr.msg_id == 100
        assert addr.reserved == 0

    def test_broadcast_property(self):
        """Тест свойства is_broadcast"""
        broadcast_addr = CommAddr(dev_addr=0, msg_id=100, reserved=0)
        assert broadcast_addr.is_broadcast is True
        
        unicast_addr = CommAddr(dev_addr=1, msg_id=100, reserved=0)
        assert unicast_addr.is_broadcast is False

    def test_dev_addr_validation(self):
        """Тест валидации dev_addr"""
        # Граничные значения
        CommAddr(dev_addr=0, msg_id=100, reserved=0)  # Минимум
        CommAddr(dev_addr=31, msg_id=100, reserved=0)  # Максимум
        
        # Неправильные значения
        with pytest.raises(ValidationError):
            CommAddr(dev_addr=-1, msg_id=100, reserved=0)
        with pytest.raises(ValidationError):
            CommAddr(dev_addr=32, msg_id=100, reserved=0)

    def test_msg_id_validation(self):
        """Тест валидации msg_id"""
        # Граничные значения
        CommAddr(dev_addr=1, msg_id=0, reserved=0)     # Минимум
        CommAddr(dev_addr=1, msg_id=1023, reserved=0)  # Максимум
        
        # Неправильные значения
        with pytest.raises(ValidationError):
            CommAddr(dev_addr=1, msg_id=-1, reserved=0)
        with pytest.raises(ValidationError):
            CommAddr(dev_addr=1, msg_id=1024, reserved=0)

    def test_reserved_validation(self):
        """Тест валидации reserved"""
        CommAddr(dev_addr=1, msg_id=100, reserved=0)
        CommAddr(dev_addr=1, msg_id=100, reserved=1)
        
        with pytest.raises(ValidationError):
            CommAddr(dev_addr=1, msg_id=100, reserved=-1)
        with pytest.raises(ValidationError):
            CommAddr(dev_addr=1, msg_id=100, reserved=2)


class TestCommData:
    def test_valid_creation(self):
        """Тест корректного создания CommData"""
        addr = CommAddr(dev_addr=1, msg_id=100, reserved=0)
        data = CommData(
            frame_id=addr,
            data=b"\x01\x02\x03\x04\x05\x06\x07\x08",
            crc16=0x1234
        )
        assert data.frame_id == addr
        assert len(data.data) == 8
        assert data.crc16 == 0x1234
        assert isinstance(data.timestamp, datetime)

    def test_data_validation(self):
        """Тест валидации данных"""
        addr = CommAddr(dev_addr=1, msg_id=100, reserved=0)
        
        # Правильная длина
        CommData(frame_id=addr, data=b"\x00" * 8, crc16=0)
        
        # Неправильная длина
        with pytest.raises(ValidationError):
            CommData(frame_id=addr, data=b"\x00" * 7, crc16=0)
        with pytest.raises(ValidationError):
            CommData(frame_id=addr, data=b"\x00" * 9, crc16=0)

    def test_timestamp_auto_generation(self):
        """Тест автогенерации timestamp"""
        addr = CommAddr(dev_addr=1, msg_id=100, reserved=0)
        data1 = CommData(frame_id=addr, data=b"\x00" * 8, crc16=0)
        data2 = CommData(frame_id=addr, data=b"\x00" * 8, crc16=0)
        
        # Timestamps должны быть близкими, но не одинаковыми
        assert abs((data2.timestamp - data1.timestamp).total_seconds()) < 1.0


class TestParsedMessage:
    def test_valid_creation(self):
        """Тест корректного создания ParsedMessage"""
        msg = ParsedMessage(
            device_address=1,
            packet_type="unicast",
            can_message_id=100,
            message_name="TestMsg",
            signals={"signal1": 42, "signal2": 3.14},
            raw_payload="0102030405060708",
            crc16="0x1234",
            crc_valid=True,
            timestamp="2024-01-01T00:00:00",
            parsed=True
        )
        assert msg.device_address == 1
        assert msg.packet_type == "unicast"
        assert msg.signals["signal1"] == 42

    def test_optional_fields(self):
        """Тест опциональных полей"""
        msg = ParsedMessage(
            device_address=1,
            packet_type="broadcast",
            can_message_id=200,
            raw_payload="0102030405060708",
            crc16="0x5678",
            crc_valid=False,
            timestamp="2024-01-01T00:00:00",
            parsed=False,
            error="Unknown message"
        )
        assert msg.message_name is None
        assert msg.signals == {}
        assert msg.error == "Unknown message"

    def test_broadcast_vs_unicast(self):
        """Тест различных типов пакетов"""
        broadcast_msg = ParsedMessage(
            device_address=0,
            packet_type="broadcast",
            can_message_id=100,
            raw_payload="0102030405060708",
            crc16="0x1234",
            crc_valid=True,
            timestamp="2024-01-01T00:00:00",
            parsed=True
        )
        assert broadcast_msg.packet_type == "broadcast"
